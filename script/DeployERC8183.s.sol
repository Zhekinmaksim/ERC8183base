// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "forge-std/console2.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../contracts/AgenticCommerce.sol";

contract DeployERC8183 is Script {
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address paymentToken = vm.envOr("PAYMENT_TOKEN", BASE_USDC);

        vm.startBroadcast(deployerPrivateKey);

        AgenticCommerce implementation = new AgenticCommerce();
        bytes memory initData =
            abi.encodeWithSelector(AgenticCommerce.initialize.selector, paymentToken, treasury);
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);

        vm.stopBroadcast();

        console2.log("AgenticCommerce implementation:", address(implementation));
        console2.log("AgenticCommerce proxy:", address(proxy));
        console2.log("Payment token:", paymentToken);
        console2.log("Treasury:", treasury);
    }
}
