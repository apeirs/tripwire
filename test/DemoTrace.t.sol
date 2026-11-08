// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Vm, console} from "forge-std/Test.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {OmniSim} from "./utils/OmniSim.sol";
import {MockSystem} from "./mocks/MockSystem.sol";
import {MockCallbackProxy} from "./mocks/MockCallbackProxy.sol";
import {Guardian} from "../src/Guardian.sol";
import {TripwireReactive} from "../src/TripwireReactive.sol";
import {Intent} from "../src/Intent.sol";
import {PanicButton} from "../src/PanicButton.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {Drainer} from "../src/mocks/Drainer.sol";

/// @notice The demo scenario, run through the in-process Omni loop with the deploy scripts' demo tokens, and printed
///         as a raw log trace. `demo/tools/build-fixture.mjs` turns the trace into `demo/fixture.json`, so the demo
///         page's mock mode replays logs emitted by the real contracts. Asserts the outcome as well.
///
///         1. Base: the cosigner pre-clears 25 tUSD to a shop; the hot wallet pays it (no trip).
///         2. Base: the hot wallet signs a phishing approval for tETH (trip #1).
///         3. Every chain's Guardian sweeps; the sweeps' own transfers come back and clear.
///         4. Base: the drainer pulls and gets nothing.
///
/// Regenerate: forge test --mt test_demoTrace -vv --json | node demo/tools/build-fixture.mjs > demo/fixture.json
contract DemoTraceTest is OmniSim {
    uint256 internal constant LASNA = 5318007;
    uint256 internal constant BASE = 84532;
    uint256 internal constant ETH = 11155111;
    uint256 internal constant UNI = 1301;

    address internal hot = makeAddr("hot");
    address internal cold = makeAddr("cold");
    address internal cosigner = makeAddr("cosigner");
    address internal attacker = makeAddr("attacker");
    address internal shop = makeAddr("shop");

    TripwireReactive internal tw;
    Drainer internal drainer;
    uint256[] internal ids;
    mapping(uint256 chainId => Guardian) internal guardianOf;
    mapping(uint256 chainId => Intent) internal intentOf;
    mapping(uint256 chainId => PanicButton) internal panicOf;
    mapping(uint256 chainId => MockERC20[]) internal tokensOf;

    uint256 internal reactNonce;
    uint256 internal callbackNonce;

    function setUp() public {
        _installSystem();
        ids = [BASE, ETH, UNI];
        address[] memory intents = new address[](3);
        address[] memory panics = new address[](3);
        for (uint256 i; i < 3; ++i) {
            uint256 id = ids[i];
            proxyOf[id] = new MockCallbackProxy();
            intentOf[id] = new Intent();
            panicOf[id] = new PanicButton();
            intents[i] = address(intentOf[id]);
            panics[i] = address(panicOf[id]);
            // same tokens and amounts as script/DeployMocks.s.sol
            tokensOf[id].push(new MockERC20("Tripwire Test USD", "tUSD", 6));
            tokensOf[id].push(new MockERC20("Tripwire Test ETH", "tETH", 18));
            tokensOf[id].push(new MockERC20("Tripwire Test DAI", "tDAI", 18));
        }
        tw = new TripwireReactive{value: 1 ether}(hot, cold, cosigner, ids, intents, panics);
        for (uint256 i; i < 3; ++i) {
            uint256 id = ids[i];
            guardianOf[id] = new Guardian(IPayable(payable(address(proxyOf[id]))), address(tw), hot, cold);
            tw.setGuardian(id, address(guardianOf[id]));
            for (uint256 k; k < 3; ++k) {
                MockERC20 t = tokensOf[id][k];
                tw.addToken(id, address(t), 0);
                t.mint(hot, 1000 * 10 ** t.decimals());
                vm.prank(hot);
                t.approve(address(guardianOf[id]), type(uint256).max);
            }
        }
        vm.prank(attacker);
        drainer = new Drainer();
    }

    function test_demoTrace() public {
        _meta();
        MockERC20 tUsd = tokensOf[BASE][0];
        MockERC20 tEth = tokensOf[BASE][1];

        // 1. a pre-cleared payment
        vm.recordLogs();
        vm.prank(cosigner);
        intentOf[BASE].intendFor(address(tUsd), shop, 25e6, 15 minutes);
        _origin("intend", BASE, vm.getRecordedLogs());

        vm.recordLogs();
        vm.prank(hot);
        tUsd.transfer(shop, 25e6);
        _origin("payment", BASE, vm.getRecordedLogs());
        assertEq(tw.trips(), 0, "intended payment must not trip");

        // 2. the phishing approval
        vm.recordLogs();
        vm.prank(hot);
        tEth.approve(address(drainer), type(uint256).max);
        _origin("phish", BASE, vm.getRecordedLogs());
        assertEq(tw.trips(), 1, "phishing approval trips");

        // 3. callbacks, Base and Unichain first (fast blocks), Ethereum Sepolia last
        uint256[3] memory order = [BASE, UNI, ETH];
        for (uint256 o; o < 3; ++o) {
            for (uint256 r; r < sys.requestCount(); ++r) {
                MockSystem.Req memory req = sys.request(r);
                if (req.chainId != order[o]) continue;
                vm.recordLogs();
                (bool ok,) = proxyOf[req.chainId].deliver(req.recipient, req.sender, req.gasLimit, req.payload);
                assertTrue(ok, "callback failed");
                Vm.Log[] memory logs = vm.getRecordedLogs();
                uint256 txHash = uint256(keccak256(abi.encode("callback-tx", req.chainId, ++callbackNonce)));
                _print("callback", "sweep", req.chainId, txHash, logs);
                _react("echo", req.chainId, txHash, logs);
            }
        }
        assertEq(tw.trips(), 1, "sweeps don't re-trip");

        // 4. the drainer finds nothing (no logs: nothing moved)
        vm.prank(attacker);
        assertEq(drainer.drain(address(tEth), hot), 0, "drainer gets nothing");
        for (uint256 i; i < 3; ++i) {
            for (uint256 k; k < 3; ++k) {
                MockERC20 t = tokensOf[ids[i]][k];
                assertEq(t.balanceOf(hot), 0, "hot emptied");
            }
        }
        assertEq(tUsd.balanceOf(cold), 975e6, "Base tUSD home, minus the paid 25");
        console.log("END");
    }

    // ------------------------------------------------------------ trace output

    function _origin(string memory step_, uint256 chainId_, Vm.Log[] memory logs_) internal {
        uint256 txHash = uint256(keccak256(abi.encode("origin-tx", chainId_, ++txNonce)));
        _print("origin", step_, chainId_, txHash, logs_);
        _react(step_, chainId_, txHash, logs_);
    }

    /// @dev Like OmniSim._deliver, but each matching log is its own react() transaction with its own trace.
    function _react(string memory step_, uint256 chainId_, uint256 txHash_, Vm.Log[] memory logs_) internal {
        for (uint256 i; i < logs_.length; ++i) {
            IReactive.LogRecord memory rec = _record(chainId_, logs_[i], txHash_, i);
            if (!sys.matches(
                    address(tw), chainId_, rec.contractAddress, [rec.topic0, rec.topic1, rec.topic2, rec.topic3]
                )) {
                continue;
            }
            vm.recordLogs();
            vm.prank(SYSTEM_ADDR);
            tw.react(rec);
            Vm.Log[] memory out = vm.getRecordedLogs();
            uint256 reactTx = uint256(keccak256(abi.encode("react-tx", ++reactNonce)));
            _print("react", step_, LASNA, reactTx, out);
        }
    }

    /// @dev One line per log: TRACE|kind|step|chainId|txHash|logIndex|emitter|topic,topic,...|data
    ///      Logs from the mock system contract and mock proxies are left out: the live ones emit their own events.
    function _print(string memory kind_, string memory step_, uint256 chainId_, uint256 txHash_, Vm.Log[] memory logs_)
        internal
        view
    {
        console.log(
            string.concat("TX|", kind_, "|", step_, "|", vm.toString(chainId_), "|", vm.toString(bytes32(txHash_)))
        );
        for (uint256 i; i < logs_.length; ++i) {
            Vm.Log memory l = logs_[i];
            if (l.emitter == SYSTEM_ADDR || l.emitter == address(proxyOf[chainId_])) continue;
            string memory topics;
            for (uint256 k; k < l.topics.length; ++k) {
                topics = string.concat(topics, k == 0 ? "" : ",", vm.toString(l.topics[k]));
            }
            console.log(
                string.concat(
                    "LOG|", vm.toString(i), "|", vm.toString(l.emitter), "|", topics, "|", vm.toString(l.data)
                )
            );
        }
    }

    function _meta() internal view {
        console.log(string.concat("META|hot|", vm.toString(hot)));
        console.log(string.concat("META|cold|", vm.toString(cold)));
        console.log(string.concat("META|cosigner|", vm.toString(cosigner)));
        console.log(string.concat("META|tripwire|", vm.toString(address(tw))));
        console.log(string.concat("META|drainer|", vm.toString(address(drainer))));
        console.log(string.concat("META|attacker|", vm.toString(attacker)));
        console.log(string.concat("META|shop|", vm.toString(shop)));
        for (uint256 i; i < 3; ++i) {
            uint256 id = ids[i];
            string memory c = vm.toString(id);
            console.log(string.concat("CHAIN|", c, "|guardian|", vm.toString(address(guardianOf[id]))));
            console.log(string.concat("CHAIN|", c, "|intent|", vm.toString(address(intentOf[id]))));
            console.log(string.concat("CHAIN|", c, "|panic|", vm.toString(address(panicOf[id]))));
            for (uint256 k; k < 3; ++k) {
                MockERC20 t = tokensOf[id][k];
                console.log(
                    string.concat(
                        "TOKEN|",
                        c,
                        "|",
                        vm.toString(address(t)),
                        "|",
                        t.symbol(),
                        "|",
                        vm.toString(uint256(t.decimals())),
                        "|",
                        vm.toString(t.balanceOf(hot))
                    )
                );
            }
        }
    }
}
