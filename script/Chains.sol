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

    /// @notice Circle's testnet USDC (FiatToken v2, 6 decimals) on a protected chain, or address(0) where there is
    ///         none. Addresses from developers.circle.com/stablecoins/usdc-contract-addresses ("Testnet"), read and
    ///         checked on-chain (symbol USDC, 6 decimals) 2026-11-08. Free test USDC: faucet.circle.com.
    function usdc(uint256 chainId_) internal pure returns (address) {
        if (chainId_ == BASE_SEPOLIA) return 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
        if (chainId_ == ETH_SEPOLIA) return 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
        if (chainId_ == UNICHAIN_SEPOLIA) return 0x31d0220469e10c4E71834a79b1f276d740d3768F;
        return address(0);
    }
}

/// @notice `depositTo()` exists on both the system contract and the callback proxies.
interface IDepositTo {
    function depositTo(address contract_) external payable;
    function debt(address contract_) external view returns (uint256);
    function reserves(address contract_) external view returns (uint256);
}
