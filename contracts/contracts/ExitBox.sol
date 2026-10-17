// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface ITokenMessengerV2 {
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}

/// @notice Everything an exit is committed to. Hashed into the box address, so a
///         relayer can only ever deploy a box that does exactly what the sender asked.
struct ExitParams {
    uint32 destinationDomain; // CCTP domain of the destination chain
    bytes32 mintRecipient; // recipient on the destination chain (left-padded EVM address)
    uint32 minFinalityThreshold; // 1000 = CCTP fast, 2000 = standard
    uint256 maxFee; // cap on CCTP protocol + Circle forwarding fees, in USDC base units
    address fallbackRecipient; // receives the funds on Base if the burn reverts
    address relayer; // paid `relayerFee` for deploying the box
    uint256 relayerFee; // in USDC base units
}

/// @title ExitBox
/// @notice Single-use, constructor-only contract. A Veil withdrawal funds the box's
///         counterfactual address; deploying it bridges the whole balance out via CCTP,
///         with Circle's Forwarding Service completing the mint on the destination chain.
///         Only a revert-only stub remains afterwards, which also makes the address single-use.
contract ExitBox {
    /// @dev Circle Forwarding Service hook: "cctp-forward", version 0, no extra data.
    bytes internal constant FORWARD_HOOK = hex"636374702d666f72776172640000000000000000000000000000000000000000";

    event Exited(uint256 bridged, uint32 destinationDomain, bytes32 mintRecipient, uint256 relayerFee);
    event FellBack(uint256 amount, address fallbackRecipient);

    constructor(IERC20 usdc, ITokenMessengerV2 messenger, ExitParams memory p) {
        uint256 balance = usdc.balanceOf(address(this));
        require(balance > p.relayerFee, "ExitBox: unfunded");

        if (p.relayerFee > 0) {
            require(usdc.transfer(p.relayer, p.relayerFee), "ExitBox: fee transfer");
        }
        uint256 amount = balance - p.relayerFee;

        usdc.approve(address(messenger), amount);
        try messenger.depositForBurnWithHook(
            amount,
            p.destinationDomain,
            p.mintRecipient,
            address(usdc),
            bytes32(0), // forwarding requires no destination caller
            p.maxFee,
            p.minFinalityThreshold,
            FORWARD_HOOK
        ) {
            emit Exited(amount, p.destinationDomain, p.mintRecipient, p.relayerFee);
        } catch {
            usdc.approve(address(messenger), 0);
            require(usdc.transfer(p.fallbackRecipient, amount), "ExitBox: fallback transfer");
            emit FellBack(amount, p.fallbackRecipient);
        }
    }
}

/// @title ExitBoxFactory
/// @notice Predicts and deploys ExitBoxes with CREATE2. Permissionless: the box
///         address commits to every parameter, so whoever deploys it can't redirect funds.
contract ExitBoxFactory {
    IERC20 public immutable usdc;
    ITokenMessengerV2 public immutable messenger;

    event BoxOpened(address indexed box, bytes32 indexed salt, uint32 destinationDomain, bytes32 mintRecipient);

    constructor(IERC20 usdc_, ITokenMessengerV2 messenger_) {
        usdc = usdc_;
        messenger = messenger_;
    }

    function initCodeHash(ExitParams calldata p) public view returns (bytes32) {
        return keccak256(abi.encodePacked(type(ExitBox).creationCode, abi.encode(usdc, messenger, p)));
    }

    function boxAddress(ExitParams calldata p, bytes32 salt) external view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash(p)))))
        );
    }

    function open(ExitParams calldata p, bytes32 salt) external returns (address box) {
        box = address(new ExitBox{salt: salt}(usdc, messenger, p));
        emit BoxOpened(box, salt, p.destinationDomain, p.mintRecipient);
    }
}
