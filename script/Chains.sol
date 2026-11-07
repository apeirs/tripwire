// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice Reactive Network addresses per chain (dev.reactive.network/origins-and-destinations, read 2026-11-08).
library Chains {
    uint256 internal constant REACTIVE_MAINNET = 1597;
    uint256 internal constant LASNA = 5318007;
    uint256 internal constant BASE_SEPOLIA = 84532;
    uint256 internal constant ETH_SEPOLIA = 11155111;
    uint256 internal constant UNICHAIN_SEPOLIA = 1301;
    uint256 internal constant BASE = 8453;
    uint256 internal constant ETHEREUM = 1;
    uint256 internal constant UNICHAIN = 130;

    /// @notice System contract on Reactive Network (mainnet and Lasna).
    address internal constant SYSTEM = 0x8888888888888888888888888888888888888888;

    error UnsupportedChain(uint256 chainId);

    function isReactive(uint256 chainId_) internal pure returns (bool) {
        return chainId_ == LASNA || chainId_ == REACTIVE_MAINNET;
    }

    /// @notice Callback proxy on a destination chain.
    function callbackProxy(uint256 chainId_) internal pure returns (address) {
        if (chainId_ == BASE_SEPOLIA) return 0x476F44b11F5C942c58f4c8E3d0300E5710743585;
        if (chainId_ == ETH_SEPOLIA) return 0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4;
        if (chainId_ == UNICHAIN_SEPOLIA) return 0x775c9B990ADe401060B78D0e98684eEf8d2466C1;
        if (chainId_ == BASE) return 0xCc780DdE33f56f55dE778D42c930959374a4a068;
        if (chainId_ == ETHEREUM) return 0xFCE1F192F489c988392aBC16E91e359d540d94Fe;
        if (chainId_ == UNICHAIN) return 0x754120EC7a6eF81E4c5c835AA603C63Da64693E6;
        revert UnsupportedChain(chainId_);
    }
}

/// @notice `depositTo()` exists on both the system contract and the callback proxies.
interface IDepositTo {
    function depositTo(address contract_) external payable;
    function debt(address contract_) external view returns (uint256);
    function reserves(address contract_) external view returns (uint256);
}
