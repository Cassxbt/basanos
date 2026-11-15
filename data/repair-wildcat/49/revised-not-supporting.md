# Role providers cannot be EOAs as stated in the documentation.

# Lines of code

https://github.com/code-423n4/2024-08-wildcat/blob/fe746cc0fbedc4447a981a50e6ba4c95f98b9fe1/src/access/AccessControlHooks.sol#L220
https://github.com/code-423n4/2024-08-wildcat/blob/fe746cc0fbedc4447a981a50e6ba4c95f98b9fe1/src/access/FixedTermLoanHooks.sol#L254


# Vulnerability details

## Impact

The [Documentation](https://docs.wildcat.finance/technical-overview/security-developer-dives/hooks/access-control-hooks#role-providers) suggests that a role provider can be a "push" provider (one that "pushes" credentials into the hooks contract by calling `grantRole`) and a "pull" provider (one that the hook calls via `getCredential` or `validateCredential`).

The documentation also states that:
> Role providers do not have to implement any of these functions - a role provider can be an EOA.

But in fact, only the initial deployer can be an EOA provider, since it is coded in the constructor. Any other EOA provider that the borrower tries to add via `addRoleProvider` will fail because it does not implement the interface.

## Proof of Concept

PoC will revert because EOA does not implement interface obviously:

```powershell
  [118781] AuditMarket::test_PoC_EOA_provider()
    ├─ [0] VM::startPrank(BORROWER1: [0xB193AC639A896a0B7a0B334a97f0095cD87427f2])
    │   └─ ← [Return]
    ├─ [29883] AccessControlHooks::addRoleProvider(RoleProvider: [0x2e234DAe75C793f67A35089C9d99245E1C58470b], 2592000 [2.592e6])
    │   ├─ [2275] RoleProvider::isPullProvider() [staticcall]
    │   │   └─ ← [Return] false
    │   ├─ emit RoleProviderAdded(providerAddress: RoleProvider: [0x2e234DAe75C793f67A35089C9d99245E1C58470b], timeToLive: 2592000 [2.592e6], pullProviderIndex: 16777215 [1.677e7])
    │   └─ ← [Stop]
    ├─ [74243] AccessControlHooks::addRoleProvider(RoleProvider: [0xF62849F9A0B5Bf2913b396098F7c7019b51A820a], 2592000 [2.592e6])
    │   ├─ [2275] RoleProvider::isPullProvider() [staticcall]
    │   │   └─ ← [Return] true
    │   ├─ emit RoleProviderAdded(providerAddress: RoleProvider: [0xF62849F9A0B5Bf2913b396098F7c7019b51A820a], timeToLive: 2592000 [2.592e6], pullProviderIndex: 0)
    │   └─ ← [Stop]
    ├─ [5547] AccessControlHooks::addRoleProvider(EOA_PROVIDER1: [0x6aAfF89c996cAa2BD28408f735Ba7A441276B03F], 2592000 [2.592e6])
    │   ├─ [0] EOA_PROVIDER1::isPullProvider() [staticcall]
    │   │   └─ ← [Stop]
    │   └─ ← [Revert] EvmError: Revert
    └─ ← [Revert] EvmError: Revert
```

PoC:
```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "forge-std/console2.sol";

import {WildcatArchController} from "../src/WildcatArchController.sol";
import {HooksFactory} from "../src/HooksFactory.sol";
import {LibStoredInitCode} from "src/libraries/LibStoredInitCode.sol";
import {WildcatMarket} from "src/market/WildcatMarket.sol";
import {AccessControlHooks} from "../src/access/AccessControlHooks.sol";
import {DeployMarketInputs} from "../src/interfaces/WildcatStructsAndEnums.sol";
import {HooksConfig, encodeHooksConfig} from "../src/types/HooksConfig.sol";

import {MockERC20} from "../test/shared/mocks/MockERC20.sol";
import {MockSanctionsSentinel} from "./shared/mocks/MockSanctionsSentinel.sol";
import {deployMockChainalysis} from "./shared/mocks/MockChainalysis.sol";
import {IRoleProvider} from "../src/access/IRoleProvider.sol";

contract AuditMarket is Test {
    WildcatArchController wildcatArchController;
    MockSanctionsSentinel internal sanctionsSentinel;
    HooksFactory hooksFactory;

    MockERC20 ERC0 = new MockERC20();

    address immutable ARCH_DEPLOYER = makeAddr("ARCH_DEPLOYER");
    address immutable FEE_RECIPIENT = makeAddr("FEE_RECIPIENT");
    address immutable BORROWER1 = makeAddr("BORROWER1");

    address immutable EOA_PROVIDER1 = makeAddr("EOA_PROVIDER1");
    address immutable PROVIDER1 = address(new RoleProvider(false));
    address immutable PROVIDER2 = address(new RoleProvider(true));

    address accessControlHooksTemplate = LibStoredInitCode.deployInitCode(type(AccessControlHooks).creationCode);

    AccessControlHooks accessControlHooksInstance;

    function _storeMarketInitCode() internal virtual returns (address initCodeStorage, uint256 initCodeHash) {
        bytes memory marketInitCode = type(WildcatMarket).creationCode;
        initCodeHash = uint256(keccak256(marketInitCode));
        initCodeStorage = LibStoredInitCode.deployInitCode(marketInitCode);
    }

    function setUp() public {
        deployMockChainalysis();
        vm.startPrank(ARCH_DEPLOYER);
        wildcatArchController = new WildcatArchController();
        sanctionsSentinel = new MockSanctionsSentinel(address(wildcatArchController));
        (address initCodeStorage, uint256 initCodeHash) = _storeMarketInitCode();
        hooksFactory =
            new HooksFactory(address(wildcatArchController), address(sanctionsSentinel), initCodeStorage, initCodeHash);

        wildcatArchController.registerControllerFactory(address(hooksFactory));
        hooksFactory.registerWithArchController();
        wildcatArchController.registerBorrower(BORROWER1);

        hooksFactory.addHooksTemplate(
            accessControlHooksTemplate, "accessControlHooksTemplate", FEE_RECIPIENT, address(ERC0), 1 ether, 500
        );
        vm.startPrank(BORROWER1);

        DeployMarketInputs memory marketInput = DeployMarketInputs({
            asset: address(ERC0),
            namePrefix: "Test",
            symbolPrefix: "TT",
            maxTotalSupply: uint128(100_000e27),
            annualInterestBips: uint16(500),
            delinquencyFeeBips: uint16(500),
            withdrawalBatchDuration: uint32(5 days),
            reserveRatioBips: uint16(500),
            delinquencyGracePeriod: uint32(5 days),
            hooks: encodeHooksConfig(address(0), true, true, false, true, false, false, false, false, false, true, false)
        });
        bytes memory hooksData = abi.encode(uint32(block.timestamp + 30 days), uint128(1e27));
        deal(address(ERC0), BORROWER1, 1 ether);
        ERC0.approve(address(hooksFactory), 1 ether);
        (address market, address hooksInstance) = hooksFactory.deployMarketAndHooks(
            accessControlHooksTemplate,
            abi.encode(BORROWER1),
            marketInput,
            hooksData,
            bytes32(bytes20(BORROWER1)),
            address(ERC0),
            1 ether
        );
        accessControlHooksInstance = AccessControlHooks(hooksInstance);
        vm.stopPrank();
    }

    function test_PoC_EOA_provider() public {
        vm.startPrank(BORROWER1);

        accessControlHooksInstance.addRoleProvider(PROVIDER1, uint32(30 days));
        accessControlHooksInstance.addRoleProvider(PROVIDER2, uint32(30 days));
        accessControlHooksInstance.addRoleProvider(EOA_PROVIDER1, uint32(30 days));
    }
}

contract RoleProvider is IRoleProvider {
    bool public isPullProvider;
    mapping(address account => uint32 timestamp) public getCredential;

    constructor(bool _isPullProvider) {
        isPullProvider = _isPullProvider;
    }

    function setCred(address account, uint32 timestamp) external {
        getCredential[account] = timestamp;
    }

    function validateCredential(address account, bytes calldata data) external returns (uint32 timestamp) {
        if (data.length != 0) {
            return uint32(block.timestamp);
        } else {
            revert("Wrong creds");
        }
    }
}
```

## Tools Used

Manual Review

## Recommended Mitigation Steps

Replace the interface call with a low-level call and check if the user implements the interface in order to be a pull provider:

```solidity
(bool succes, bytes memory data) =
    providerAddress.call(abi.encodeWithSelector(IRoleProvider.isPullProvider.selector));
bool isPullProvider;
if (succes && data.length == 0x20) {
    isPullProvider = abi.decode(data, (bool));
} else {
    isPullProvider = false;
}
```

With this code all logic works as expected, for EOA providers `pullProviderIndex` is set to `type(uint24).max`, for contracts - depending on the result of calling `isPullProvider`:
```powershell
Traces:
  [141487] AuditMarket::test_PoC_EOA_provider()
    ├─ [0] VM::startPrank(BORROWER1: [0xB193AC639A896a0B7a0B334a97f0095cD87427f2])
    │   └─ ← [Return]
    ├─ [30181] AccessControlHooks::addRoleProvider(RoleProvider: [0x2e234DAe75C793f67A35089C9d99245E1C58470b], 2592000 [2.592e6])
    │   ├─ [2275] RoleProvider::isPullProvider()
    │   │   └─ ← [Return] false
    │   ├─ emit RoleProviderAdded(providerAddress: RoleProvider: [0x2e234DAe75C793f67A35089C9d99245E1C58470b], timeToLive: 2592000 [2.592e6], pullProviderIndex: 16777215 [1.677e7])
    │   └─ ← [Stop]
    ├─ [74541] AccessControlHooks::addRoleProvider(RoleProvider: [0xF62849F9A0B5Bf2913b396098F7c7019b51A820a], 2592000 [2.592e6])
    │   ├─ [2275] RoleProvider::isPullProvider()
    │   │   └─ ← [Return] true
    │   ├─ emit RoleProviderAdded(providerAddress: RoleProvider: [0xF62849F9A0B5Bf2913b396098F7c7019b51A820a], timeToLive: 2592000 [2.592e6], pullProviderIndex: 0)
    │   └─ ← [Stop]
    ├─ [27653] AccessControlHooks::addRoleProvider(EOA_PROVIDER1: [0x6aAfF89c996cAa2BD28408f735Ba7A441276B03F], 2592000 [2.592e6])
    │   ├─ [0] EOA_PROVIDER1::isPullProvider()
    │   │   └─ ← [Stop]
    │   ├─ emit RoleProviderAdded(providerAddress: EOA_PROVIDER1: [0x6aAfF89c996cAa2BD28408f735Ba7A441276B03F], timeToLive: 2592000 [2.592e6], pullProviderIndex: 16777215 [1.677e7])
    │   └─ ← [Stop]
    └─ ← [Stop]
```


## Assessed type

Invalid Validation

## Proof of concept (executed against the audited commit)

Test file `test/repair/Poc49.t.sol`, run with `forge test --match-path test/repair/Poc49.t.sol -vv` against the unmodified audited code (real `HooksFactory`, `WildcatMarket` and `AccessControlHooks` from the repo's `BaseMarketTest`, plus the repo's `MockFixedTermLoanHooks` wrapper for the second hooks type).

What the tests show:
- `test_addRoleProvider_EOA_reverts_AccessControlHooks` and `test_addRoleProvider_EOA_reverts_FixedTermLoanHooks`: `addRoleProvider(EOA, ttl)` by the borrower reverts with empty revert data in both hooks contracts (the high-level `isPullProvider()` call on an address with no code).
- `test_unregisteredEOA_cannotGrantRole`: as a consequence the EOA is never a registered provider, its `grantRole` reverts with `ProviderNotFound`, and a lender who needs a credential to queue a withdrawal gets `NotApprovedLender`.
- Limits of the impact, shown by the same test file: `test_borrowerEOA_isProvider_andCanUnblockLender` (the deployer-borrower is itself an EOA provider, registered in the constructor, and can grant the credential, after which the lender withdraws) and `test_contractWrapper_workaround` (a one-function contract that forwards `grantRole` from the operator EOA can be added, and then the lender withdraws). So the restriction does not by itself cause loss of funds or a market DoS; it prevents a borrower from registering any EOA other than itself as a role provider.

### Test code

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.20;

import '../BaseMarketTest.sol';
import {MockFixedTermLoanHooks} from '../shared/mocks/MockFixedTermLoanHooks.sol';
import 'src/access/IRoleProvider.sol';

/// Minimal contract provider: forwards `grantRole` calls from its operator EOA to the hooks.
contract ForwardingPushProvider is IRoleProvider {
  address public immutable operator;

  constructor(address _operator) {
    operator = _operator;
  }

  function isPullProvider() external pure override returns (bool) {
    return false;
  }

  function getCredential(address) external pure override returns (uint32) {
    return 0;
  }

  function validateCredential(address, bytes calldata) external pure override returns (uint32) {
    return 0;
  }

  function grant(AccessControlHooks hooks, address account) external {
    require(msg.sender == operator);
    hooks.grantRole(account, uint32(block.timestamp));
  }
}

contract Poc49Test is BaseMarketTest {
  address internal kycOperator = address(0x4b1c); // an EOA the borrower wants to use as a push provider
  address internal erin = address(0xe41);

  function setUp() public override {
    super.setUp();
    // erin receives market tokens (transfers do not require access), so she is not a known lender
    // and needs a credential before she can queue a withdrawal.
    vm.prank(alice);
    market.depositUpTo(10e18);
    vm.prank(alice);
    market.transfer(erin, 1e18);
    assertEq(kycOperator.code.length, 0, 'operator is an EOA');
  }

  function test_addRoleProvider_EOA_reverts_AccessControlHooks() external {
    vm.prank(borrower);
    (bool ok, bytes memory ret) = address(hooks).call(
      abi.encodeCall(AccessControlHooks.addRoleProvider, (kycOperator, 30 days))
    );
    assertFalse(ok, 'addRoleProvider(EOA) reverts');
    assertEq(ret.length, 0, 'empty revert data (extcodesize check on the isPullProvider call)');
  }

  function test_addRoleProvider_EOA_reverts_FixedTermLoanHooks() external {
    MockFixedTermLoanHooks ftHooks = new MockFixedTermLoanHooks(address(this));
    (bool ok, bytes memory ret) = address(ftHooks).call(
      abi.encodeCall(ftHooks.addRoleProvider, (kycOperator, 30 days))
    );
    assertFalse(ok);
    assertEq(ret.length, 0);
  }

  // Consequence: the EOA can never act as a push provider, so it cannot grant credentials.
  function test_unregisteredEOA_cannotGrantRole() external {
    vm.prank(kycOperator);
    vm.expectRevert(AccessControlHooks.ProviderNotFound.selector);
    hooks.grantRole(erin, uint32(block.timestamp));

    (bool ok, bytes memory ret) = _queueWithdrawal(erin);
    assertFalse(ok, 'erin cannot withdraw without a credential');
    assertEq(bytes4(ret), AccessControlHooks.NotApprovedLender.selector);
  }

  // Limit of the impact: the deployer-borrower is itself an EOA provider (registered in the
  // constructor) and can always grant, so lenders are never stuck by this alone.
  function test_borrowerEOA_isProvider_andCanUnblockLender() external {
    vm.prank(borrower);
    hooks.grantRole(erin, uint32(block.timestamp));
    (bool ok, ) = _queueWithdrawal(erin);
    assertTrue(ok, 'erin withdraws after the borrower EOA grants a credential');
  }

  // Limit of the impact: a one-contract wrapper works around the restriction.
  function test_contractWrapper_workaround() external {
    ForwardingPushProvider wrapper = new ForwardingPushProvider(kycOperator);
    vm.prank(borrower);
    hooks.addRoleProvider(address(wrapper), 30 days);
    vm.prank(kycOperator);
    wrapper.grant(hooks, erin);
    (bool ok, ) = _queueWithdrawal(erin);
    assertTrue(ok);
  }

  function _queueWithdrawal(address from) internal returns (bool ok, bytes memory ret) {
    vm.prank(from);
    (ok, ret) = address(market).call(abi.encodeCall(market.queueWithdrawal, (1e18)));
  }
}
```

### forge output

```
Warning: Found unknown `fuzz_runs` config for profile `coverage` defined in foundry.toml.
No files changed, compilation skipped
error: unresolved symbol `locals`
   --> src/spherex/SphereXProtectedRegisteredBase.sol:153:39
    |
153 |   ) internal returnsIfNotActivatedPre(locals) returns (ModifierLocals memory locals) {
    |                                       ^^^^^^


Ran 5 tests for test/repair/Poc49.t.sol:Poc49Test
[PASS] test_addRoleProvider_EOA_reverts_AccessControlHooks() (gas: 18886)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.

[PASS] test_addRoleProvider_EOA_reverts_FixedTermLoanHooks() (gas: 5058783)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.

[PASS] test_borrowerEOA_isProvider_andCanUnblockLender() (gas: 201544)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.

[PASS] test_contractWrapper_workaround() (gas: 498339)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.

[PASS] test_unregisteredEOA_cannotGrantRole() (gas: 66830)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.

Suite result: ok. 5 passed; 0 failed; 0 skipped; finished in 4.45ms (1.07ms CPU time)

Ran 1 test suite in 150.80ms (4.45ms CPU time): 5 tests passed, 0 failed, 0 skipped (5 total tests)
```

## Response to the pre-screen checklist

1. Invariant break, loss or DoS: not shown, and the tests indicate none follows from this alone. The demonstrated effect is that a borrower cannot register an EOA (other than itself) as a role provider, so that EOA cannot push credentials (`test_unregisteredEOA_cannotGrantRole`); the borrower's own `grantRole` and a forwarding contract provider both unblock the lender (`test_borrowerEOA_isProvider_andCanUnblockLender`, `test_contractWrapper_workaround`). The impact is a functional limitation of provider management, not a loss of funds.
2. Binding contest requirement: not established by what is in the repository. The in-repo docs (`docs/hooks/templates/Access Control Hooks.md`) define a role provider as "an Ethereum account" that can push credentials by calling `grantRole` and say "The provider itself defines whether it is a 'pull provider'", and `README.md` points to the Gitbook for expected behaviour. The sentence quoted in the report ("a role provider can be an EOA") is not present in the repository copy of the docs and I did not verify it against the Gitbook, so I cannot cite a contest policy clause or invariant that requires EOA providers.
