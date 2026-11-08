// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {Guardian} from "../../src/Guardian.sol";
import {Chains} from "../../script/Chains.sol";
import {MockCallbackProxy} from "../mocks/MockCallbackProxy.sol";

interface IFiatToken {
    function masterMinter() external view returns (address);
    function configureMinter(address minter, uint256 allowance) external returns (bool);
    function mint(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @notice Sweeps Circle's real testnet USDC bytecode (FiatToken proxy + implementation) on a fork of each chain.
///         Read-only against the RPC: nothing is sent to any network. Off by default; run with
///         FORK_TESTS=1 BASE_RPC=... ETH_RPC=... UNI_RPC=... forge test --mc UsdcForkTest -vv
contract UsdcForkTest is Test {
    uint256 internal constant AMOUNT = 20e6;

    function _run(string memory rpcEnv_, uint256 chainId_) internal {
        string memory rpc = vm.envOr(rpcEnv_, string(""));
        if (!vm.envOr("FORK_TESTS", false) || bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        assertEq(block.chainid, chainId_, "RPC is for another chain");
        IFiatToken usdc = IFiatToken(Chains.usdc(chainId_));
        assertEq(usdc.decimals(), 6);

        address hot = makeAddr("fork-hot");
        address cold = makeAddr("fork-cold");
        address tripwire = makeAddr("fork-tripwire");
        // Fresh USDC for HOT the way Circle mints it: the master minter configures a minter, which mints.
        vm.prank(usdc.masterMinter());
        usdc.configureMinter(address(this), AMOUNT);
        usdc.mint(hot, AMOUNT);

        MockCallbackProxy proxy = new MockCallbackProxy();
        Guardian g = new Guardian(IPayable(payable(address(proxy))), tripwire, hot, cold);
        vm.prank(hot);
        usdc.approve(address(g), type(uint256).max);

        address[] memory list = new address[](1);
        list[0] = address(usdc);
        (bool ok, uint256 gasUsed) =
            proxy.deliver(address(g), tripwire, 650_000 + 60_000, abi.encodeCall(Guardian.sweep, (address(0), 1, list)));
        assertTrue(ok, "callback ran");
        assertEq(usdc.balanceOf(cold), AMOUNT, "real USDC swept to COLD");
        assertEq(usdc.balanceOf(hot), 0);
        assertGe(usdc.allowance(hot, address(g)), 1 << 128, "Guardian still armed after the spend-down");
        emit log_named_uint("sweep gas (1 real USDC, cold slots)", gasUsed);
    }

    function test_fork_baseSepoliaUsdc() public {
        _run("BASE_RPC", Chains.BASE_SEPOLIA);
    }

    function test_fork_ethSepoliaUsdc() public {
        _run("ETH_RPC", Chains.ETH_SEPOLIA);
    }

    function test_fork_unichainSepoliaUsdc() public {
        _run("UNI_RPC", Chains.UNICHAIN_SEPOLIA);
    }
}
