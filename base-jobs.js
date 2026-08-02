/**
 * base-jobs.js - ERC-8183 job lifecycle + ERC-8004 validation on Base mainnet.
 *
 * Uses YOUR OWN deployed AgenticCommerce contract (see DEPLOY_ERC8183.md).
 * The official reference implementation is NOT deployed on Base mainnet by
 * anyone else as of this writing, so deploying your own gives an exclusive
 * Jobs+Validation layer on Base.
 *
 * Wallets are paired: (w0=client, w1=provider), (w2=client, w3=provider), ...
 * For each pair we run the full ERC-8183 job lifecycle:
 *   createJob -> setBudget -> approve USDC -> fund -> submit -> complete
 * The client is also the evaluator.
 *
 * Optionally (VALIDATION=true) we also run ERC-8004 validation for the
 * provider's agent: owner requests validation, validator responds.
 *
 * IMPORTANT:
 *   - Set AGENTIC_COMMERCE env var to YOUR deployed contract address
 *     (from DEPLOY_ERC8183.md output). This script does NOT work without it.
 *   - USDC on Base is a standard ERC-20 (6 decimals) at the address below.
 *   - Client wallet needs USDC (from swap-usdc.js) to cover escrow budget.
 *   - Gas is paid in ETH separately (very cheap on Base, ~$0.002/tx).
 *
 * Run: AGENTIC_COMMERCE=0xYourContract node base-jobs.js
 * Reads wallets.txt / proxies.txt / .env; writes results-base-jobs.json.
 * Reads results.json (if present) to map provider wallets -> agentId for
 * the validation step.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync } from "fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  decodeEventLog,
  keccak256,
  toHex,
  parseUnits,
  formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import PinataSDK from "@pinata/sdk";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

// ---------- contracts ----------

// YOUR deployed contract - see DEPLOY_ERC8183.md. No default - must be set.
const AGENTIC_COMMERCE = process.env.AGENTIC_COMMERCE;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base (6 decimals)
const VALIDATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63"; // ERC-8004 Reputation Registry on Base
// Note: Base's ERC-8004 deployment combines identity+reputation; there is no
// separate ValidationRegistry contract at time of writing. If/when one exists
// on Base mainnet, set VALIDATION_REGISTRY_ADDR env to override.
const VALIDATION_REGISTRY_ADDR = process.env.VALIDATION_REGISTRY_ADDR || VALIDATION_REGISTRY;

const AGENTIC_ABI = parseAbi([
  "function createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) external returns (uint256 jobId)",
  "function setBudget(uint256 jobId, uint256 amount, bytes optParams) external",
  "function fund(uint256 jobId, bytes optParams) external",
  "function submit(uint256 jobId, bytes32 deliverable, bytes optParams) external",
  "function complete(uint256 jobId, bytes32 reason, bytes optParams) external",
  "function reject(uint256 jobId, bytes32 reason, bytes optParams) external",
  "function getJob(uint256 jobId) external view returns ((uint256 id, address client, address provider, address evaluator, string description, uint256 budget, uint256 expiredAt, uint8 status, address hook))",
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
]);

const VALIDATION_ABI = parseAbi([
  "function validationRequest(address validator, uint256 agentId, string requestURI, bytes32 requestHash) external",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag) external",
  "function getValidationStatus(bytes32 requestHash) external view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
]);

const STATUS_NAMES = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];

// ---------- config ----------

const RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const WALLETS_FILE = process.env.WALLETS_FILE || "wallets.txt";
const PROXIES_FILE = process.env.PROXIES_FILE || "proxies.txt";
const RESULTS_FILE = process.env.JOBS_RESULTS_FILE || "results-base-jobs.json";
const AGENTS_FILE = process.env.RESULTS_FILE || "results.json";

// Job budget in USDC (ERC-20, 6 decimals). Range for variety.
const JOB_BUDGET_MIN_USDC = process.env.JOB_BUDGET_MIN_USDC || "0.05";
const JOB_BUDGET_MAX_USDC = process.env.JOB_BUDGET_MAX_USDC || "0.30";

const VALIDATION = (process.env.VALIDATION || "false") === "true";
const DELAY_MIN_SEC = parseFloat(process.env.DELAY_MIN_SEC || "10");
const DELAY_MAX_SEC = parseFloat(process.env.DELAY_MAX_SEC || "60");

// Variety knobs
const JOB_IPFS = (process.env.JOB_IPFS || "true") === "true";
const JOB_LLM_DESC = (process.env.JOB_LLM_DESC || "true") === "true";
const JOB_REJECT_RATE = parseFloat(process.env.JOB_REJECT_RATE || "0.15");

// ---------- helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function saveResults(path, data) {
  try { if (existsSync(path)) copyFileSync(path, path + ".bak"); } catch {}
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomDelay(minSec, maxSec) {
  if (maxSec <= 0) return 0;
  const min = Math.max(0, minSec);
  const max = Math.max(min, maxSec);
  return (min + Math.random() * (max - min)) * 1000;
}

function randomBudget() {
  const min = parseFloat(JOB_BUDGET_MIN_USDC);
  const max = parseFloat(JOB_BUDGET_MAX_USDC);
  const v = min + Math.random() * (max - min);
  const rounded = Math.round(v * 100) / 100;
  return { human: rounded.toFixed(2), units: parseUnits(rounded.toFixed(2), 6) };
}

function normalizeProxy(raw) {
  if (!raw) return null;
  const t = raw.trim();
  if (!t || t.startsWith("#")) return null;
  if (/^(https?|socks5h?|socks4):\/\//i.test(t)) return t;
  const p = t.split(":");
  if (p.length === 4) return `http://${encodeURIComponent(p[2])}:${encodeURIComponent(p[3])}@${p[0]}:${p[1]}`;
  if (p.length === 2) return `http://${p[0]}:${p[1]}`;
  throw new Error(`Cannot parse proxy: ${raw}`);
}

async function proxiedFetch(proxyUrl) {
  if (!proxyUrl) return undefined;
  try {
    const { ProxyAgent, fetch: undiciFetch } = await import("undici");
    const dispatcher = new ProxyAgent({
      uri: proxyUrl,
      requestTls: { rejectUnauthorized: false },
      connect: { timeout: 30_000 },
    });
    return (input, init = {}) => {
      let url = input;
      let merged = { ...init };
      if (typeof input === "object" && input !== null && "url" in input) {
        url = input.url;
        merged = { method: input.method, headers: input.headers, body: init.body ?? input.body, ...init };
      }
      if (merged.body) merged.duplex = "half";
      return undiciFetch(url, { ...merged, dispatcher });
    };
  } catch {
    return undefined;
  }
}

function clients(account, fetchImpl) {
  const transport = http(RPC_URL, fetchImpl ? { fetch: fetchImpl } : undefined);
  return {
    publicClient: createPublicClient({ chain: base, transport }),
    walletClient: createWalletClient({ account, chain: base, transport }),
  };
}

// ---------- IPFS + LLM for job variety ----------

function buildProxyAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) return new SocksProxyAgent(proxyUrl);
  return new HttpsProxyAgent(proxyUrl);
}

function buildPinata(proxyUrl) {
  const opts = {};
  if (proxyUrl) {
    const agent = buildProxyAgent(proxyUrl);
    opts.httpAgent = agent;
    opts.httpsAgent = agent;
  }
  return new PinataSDK(process.env.PINATA_API_KEY, process.env.PINATA_SECRET_KEY, opts);
}

async function pinJSON(pinata, json, name) {
  const res = await pinata.pinJSONToIPFS(json, { pinataMetadata: { name } });
  return `ipfs://${res.IpfsHash}`;
}

const JOB_TEMPLATES = {
  trading: ["Backtest a momentum strategy on 30d ETH/USDC", "Scan 3 DEXs for arbitrage spreads >10bps", "Rebalance a 5-asset index to target weights"],
  payments: ["Route a 500 USDC payout across lowest-fee rails", "Reconcile a batch of 50 settlement records", "Validate routing for a payout batch"],
  data: ["Aggregate hourly TVL across 4 Base protocols", "Clean and dedupe a 10k-row address list", "Build a 7d volume time-series for 6 pairs"],
  research: ["Summarize 3 governance proposals into a brief", "Map competitor fee schedules into a table", "Draft a risk memo on a new lending market"],
  security: ["Audit an allowance list for over-approvals", "Monitor a treasury wallet for anomalous outflows", "Triage 3 incident alerts and rank severity"],
  defi: ["Simulate a vault APY under 3 utilization curves", "Find best stablecoin LP for a 5k position", "Estimate impermanent loss for a 30d window"],
  ops: ["Compile a weekly uptime report for 8 endpoints", "Rotate API keys across a 12-service fleet", "Generate an on-call handoff summary"],
  infra: ["Benchmark RPC latency across 4 Base providers", "Validate a 20-node config for drift", "Produce a capacity forecast for next quarter"],
};

function templateDescription(category) {
  const pool = JOB_TEMPLATES[category] || JOB_TEMPLATES.data;
  return pool[Math.floor(Math.random() * pool.length)];
}

let _anthropic = null;
function anthropicClient() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

async function generateJobDescriptions(providerAgents) {
  const list = providerAgents
    .map((a, i) => `${i + 1}. ${a.name} - role: ${a.role || a.category || "agent"}`)
    .join("\n");

  const prompt = `For each agent below, write ONE realistic micro-task another party would hire it to do, matching its role. Each task: 6-14 words, concrete, specific, no fluff, no agent name in the text. Vary verbs and structure - they must NOT sound templated.

Agents:
${list}

Return only a JSON array of strings, one per agent in order, no markdown:
["task for agent 1", "task for agent 2", ...]`;

  const resp = await anthropicClient().messages.create({
    model: process.env.HAIKU_MODEL || "claude-haiku-4-5",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });
  const raw = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const arr = JSON.parse(raw.replace(/```json|```/g, "").trim());
  if (!Array.isArray(arr)) throw new Error("bad job descriptions");
  return arr;
}

function buildDeliverable(entry, description, budgetHuman) {
  return {
    jobType: "erc-8183",
    network: "base",
    agentRegistry: `eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`,
    providerAgentId: entry?.agentId ? Number(entry.agentId) : null,
    role: entry?.agentRole || null,
    task: description,
    budgetUSDC: budgetHuman,
    deliveredAt: new Date().toISOString(),
    summary: `Completed: ${description}`,
    artifacts: [
      { kind: "report", note: "result summary attached" },
    ],
  };
}

async function send(walletClient, publicClient, params, label) {
  const hash = await walletClient.writeContract(params);
  console.log(`    ${label} tx: ${hash}`);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

// ---------- job lifecycle for one (client, provider) pair ----------

async function runJob({ clientPk, providerPk, clientProxy, providerProxy, providerEntry, description, budget }) {
  const clientAccount = privateKeyToAccount(clientPk);
  const providerAccount = privateKeyToAccount(providerPk);
  const providerAgentId = providerEntry?.agentId || null;

  const clientFetch = await proxiedFetch(clientProxy);
  const providerFetch = await proxiedFetch(providerProxy);
  const c = clients(clientAccount, clientFetch);
  const p = clients(providerAccount, providerFetch);

  // Check client USDC balance for escrow
  const bal = await c.publicClient.readContract({
    address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [clientAccount.address],
  });
  if (bal < budget.units) {
    throw new Error(`client USDC ${formatUnits(bal, 6)} < budget ${budget.human} - fund client wallet`);
  }

  const block = await c.publicClient.getBlock();
  const expiredAt = block.timestamp + 3600n;

  // 1. createJob (client). client is also evaluator.
  const createHash = await send(c.walletClient, c.publicClient, {
    address: AGENTIC_COMMERCE, abi: AGENTIC_ABI, functionName: "createJob",
    args: [providerAccount.address, clientAccount.address, expiredAt, description, "0x0000000000000000000000000000000000000000"],
  }, "createJob");

  const receipt = await c.publicClient.getTransactionReceipt({ hash: createHash });
  let jobId = null;
  for (const log of receipt.logs) {
    try {
      const dec = decodeEventLog({ abi: AGENTIC_ABI, data: log.data, topics: log.topics });
      if (dec.eventName === "JobCreated") { jobId = dec.args.jobId; break; }
    } catch {}
  }
  if (jobId === null) throw new Error("JobCreated not found");
  console.log(`    jobId: ${jobId}  budget: ${budget.human} USDC`);
  console.log(`    task: "${description}"`);

  // 2. setBudget (provider)
  await send(p.walletClient, p.publicClient, {
    address: AGENTIC_COMMERCE, abi: AGENTIC_ABI, functionName: "setBudget",
    args: [jobId, budget.units, "0x"],
  }, "setBudget");

  // 3. approve USDC (client)
  await send(c.walletClient, c.publicClient, {
    address: USDC, abi: ERC20_ABI, functionName: "approve",
    args: [AGENTIC_COMMERCE, budget.units],
  }, "approve");

  // 4. fund (client)
  await send(c.walletClient, c.publicClient, {
    address: AGENTIC_COMMERCE, abi: AGENTIC_ABI, functionName: "fund",
    args: [jobId, "0x"],
  }, "fund");

  // 5. submit deliverable (provider)
  let deliverableURI = null;
  let deliverableHash;
  if (JOB_IPFS) {
    try {
      const pinata = buildPinata(providerProxy);
      const doc = buildDeliverable(providerEntry, description, budget.human);
      deliverableURI = await pinJSON(pinata, doc, `deliverable-job${jobId}.json`);
      deliverableHash = keccak256(toHex(deliverableURI));
      console.log(`    deliverable: ${deliverableURI}`);
    } catch (e) {
      console.log(`    (deliverable ipfs skipped: ${e.message?.slice(0, 50)})`);
      deliverableHash = keccak256(toHex(`deliverable-${jobId}-${Date.now()}`));
    }
  } else {
    deliverableHash = keccak256(toHex(`deliverable-${jobId}-${Date.now()}`));
  }
  await send(p.walletClient, p.publicClient, {
    address: AGENTIC_COMMERCE, abi: AGENTIC_ABI, functionName: "submit",
    args: [jobId, deliverableHash, "0x"],
  }, "submit");

  // 6. complete OR reject (client/evaluator)
  const rejected = Math.random() < JOB_REJECT_RATE;
  if (rejected) {
    const reasonHash = keccak256(toHex("did-not-meet-spec"));
    await send(c.walletClient, c.publicClient, {
      address: AGENTIC_COMMERCE, abi: AGENTIC_ABI, functionName: "reject",
      args: [jobId, reasonHash, "0x"],
    }, "reject");
  } else {
    const reasonHash = keccak256(toHex("approved"));
    await send(c.walletClient, c.publicClient, {
      address: AGENTIC_COMMERCE, abi: AGENTIC_ABI, functionName: "complete",
      args: [jobId, reasonHash, "0x"],
    }, "complete");
  }

  const job = await c.publicClient.readContract({
    address: AGENTIC_COMMERCE, abi: AGENTIC_ABI, functionName: "getJob", args: [jobId],
  });
  const status = STATUS_NAMES[Number(job.status)];
  console.log(`    final status: ${status}, budget ${formatUnits(job.budget, 6)} USDC`);

  const result = {
    jobId: jobId.toString(),
    status,
    rejected,
    budget: budget.human,
    description,
    deliverableHash,
    deliverableURI,
    createTx: createHash,
  };

  // Optional ERC-8004 validation - NOTE: Base's registry may not have a
  // separate validationRequest/Response surface. Test this before enabling.
  if (VALIDATION && providerAgentId != null && !rejected) {
    try {
      const requestURI = "";
      const requestHash = keccak256(toHex(`validation-${providerAgentId}-${jobId}`));

      await send(p.walletClient, p.publicClient, {
        address: VALIDATION_REGISTRY_ADDR, abi: VALIDATION_ABI, functionName: "validationRequest",
        args: [clientAccount.address, BigInt(providerAgentId), requestURI, requestHash],
      }, "validationRequest");

      await send(c.walletClient, c.publicClient, {
        address: VALIDATION_REGISTRY_ADDR, abi: VALIDATION_ABI, functionName: "validationResponse",
        args: [requestHash, 100, "", `0x${"0".repeat(64)}`, "job_completed"],
      }, "validationResponse");

      result.validation = { requestHash, response: 100, tag: "job_completed" };
      console.log(`    validation: passed (agentId ${providerAgentId})`);
    } catch (e) {
      console.log(`    validation skipped: ${e.shortMessage || e.message}`);
    }
  }

  return result;
}

// ---------- main ----------

async function main() {
  if (!AGENTIC_COMMERCE) {
    console.error("AGENTIC_COMMERCE env var not set. Deploy your own contract first - see DEPLOY_ERC8183.md");
    console.error("Then run: AGENTIC_COMMERCE=0xYourContract node base-jobs.js");
    process.exit(1);
  }

  let keys = readFileSync(WALLETS_FILE, "utf-8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .map((l) => (l.startsWith("0x") ? l : `0x${l}`));

  let proxies = [];
  if (existsSync(PROXIES_FILE)) {
    proxies = readFileSync(PROXIES_FILE, "utf-8").split("\n").map((l) => {
      const s = l.trim();
      return !s || s.startsWith("#") ? null : normalizeProxy(s);
    });
  }

  if (keys.length < 2) {
    console.error("need at least 2 wallets (client + provider)");
    process.exit(1);
  }

  if (JOB_LLM_DESC && !process.env.ANTHROPIC_API_KEY) {
    console.error("JOB_LLM_DESC=true needs ANTHROPIC_API_KEY (or set JOB_LLM_DESC=false)");
    process.exit(1);
  }
  if (JOB_IPFS && (!process.env.PINATA_API_KEY || !process.env.PINATA_SECRET_KEY)) {
    console.error("JOB_IPFS=true needs PINATA_API_KEY + PINATA_SECRET_KEY (or set JOB_IPFS=false)");
    process.exit(1);
  }

  // map provider wallet -> full agent entry from results.json
  const agentByWallet = new Map();
  if (existsSync(AGENTS_FILE)) {
    const agents = JSON.parse(readFileSync(AGENTS_FILE, "utf-8"));
    for (const r of agents) {
      if (r.agentId && r.wallet && r.chain === "base") agentByWallet.set(r.wallet.toLowerCase(), r);
    }
  }

  const units = keys.map((pk, i) => ({ pk, proxy: proxies[i] || null }));

  const RANDOM_PAIRS = (process.env.RANDOM_PAIRS || "true") === "true";
  const ordered = RANDOM_PAIRS ? shuffle(units) : units;

  const pairs = [];
  for (let i = 0; i + 1 < ordered.length; i += 2) {
    pairs.push({
      clientPk: ordered[i].pk,
      providerPk: ordered[i + 1].pk,
      clientProxy: ordered[i].proxy,
      providerProxy: ordered[i + 1].proxy,
    });
  }

  console.log(`Base ERC-8183 Jobs (contract: ${AGENTIC_COMMERCE})`);
  console.log(`pairs:        ${pairs.length} (client+provider)`);
  console.log(`pairing:      ${RANDOM_PAIRS ? "random" : "adjacent"}`);
  console.log(`budget range: ${JOB_BUDGET_MIN_USDC}-${JOB_BUDGET_MAX_USDC} USDC`);
  console.log(`reject rate:  ${(JOB_REJECT_RATE * 100).toFixed(0)}%`);
  console.log(`deliverable:  ${JOB_IPFS ? "IPFS JSON" : "hash only"}`);
  console.log(`descriptions: ${JOB_LLM_DESC ? "LLM (Haiku)" : "templates"}`);
  console.log(`validation:   ${VALIDATION}`);
  if (ordered.length % 2 === 1) {
    console.log(`note: odd wallet count - one wallet unpaired this run`);
  }

  let descriptions = [];
  const providerEntriesForDesc = pairs.map((pr) => {
    const provAddr = privateKeyToAccount(pr.providerPk).address.toLowerCase();
    const e = agentByWallet.get(provAddr);
    return {
      name: e?.agentName || "agent",
      role: e?.agentRole || null,
      category: e?.category || "data",
    };
  });
  if (JOB_LLM_DESC) {
    try {
      console.log(`\ngenerating ${pairs.length} job descriptions via haiku...`);
      descriptions = await generateJobDescriptions(providerEntriesForDesc);
      console.log(`got ${descriptions.length} descriptions`);
    } catch (e) {
      console.log(`LLM descriptions failed (${e.message?.slice(0, 60)}), using templates`);
      descriptions = providerEntriesForDesc.map((p) => templateDescription(p.category));
    }
  } else {
    descriptions = providerEntriesForDesc.map((p) => templateDescription(p.category));
  }

  const results = [];
  if (existsSync(RESULTS_FILE)) {
    results.push(...JSON.parse(readFileSync(RESULTS_FILE, "utf-8")));
    console.log(`resuming - ${results.length} jobs done`);
  }

  const providersDone = new Set(
    results.filter((r) => !r.error && r.provider).map((r) => r.provider.toLowerCase()),
  );

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const clientAddr = privateKeyToAccount(pair.clientPk).address;
    const providerAddr = privateKeyToAccount(pair.providerPk).address;

    if (providersDone.has(providerAddr.toLowerCase())) {
      console.log(`[${i + 1}/${pairs.length}] provider ${providerAddr.slice(0,8)} already paid, skip`);
      continue;
    }

    if (i > 0) {
      const ms = randomDelay(DELAY_MIN_SEC, DELAY_MAX_SEC);
      if (ms > 0) { console.log(`\nwaiting ${(ms/1000).toFixed(1)}s...`); await sleep(ms); }
    }

    const providerEntry = agentByWallet.get(providerAddr.toLowerCase()) || null;
    const providerAgentId = providerEntry?.agentId || null;
    const description = descriptions[i] || templateDescription(providerEntriesForDesc[i].category);
    const budget = randomBudget();
    console.log(`\n[${i + 1}/${pairs.length}] client ${clientAddr.slice(0,10)} -> provider ${providerAddr.slice(0,10)}${providerAgentId ? ` (agent ${providerAgentId})` : ""}`);

    try {
      const job = await runJob({ ...pair, providerEntry, description, budget });
      results.push({ client: clientAddr, provider: providerAddr, ...job, timestamp: new Date().toISOString() });
      providersDone.add(providerAddr.toLowerCase());
      saveResults(RESULTS_FILE, results);
    } catch (err) {
      console.error(`    failed: ${err.shortMessage || err.message}`);
      results.push({ client: clientAddr, provider: providerAddr, error: err.shortMessage || err.message, timestamp: new Date().toISOString() });
      saveResults(RESULTS_FILE, results);
    }
  }

  console.log(`\ndone. results in ${RESULTS_FILE}`);
}

main().catch((e) => {
  console.error("fatal:", e.shortMessage || e.message);
  process.exit(1);
});
