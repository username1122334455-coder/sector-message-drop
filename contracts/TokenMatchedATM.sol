// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract TokenMatchedATM is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable acceptedToken;

    uint256 public requiredDeposit;
    uint256 public payoutAmount;
    bool public paused;

    event Claimed(address indexed user, uint256 depositAmount, uint256 payoutAmount);
    event Funded(address indexed sender, uint256 amount);
    event TermsUpdated(uint256 requiredDeposit, uint256 payoutAmount);
    event PauseChanged(bool paused);
    event NativeWithdrawn(address indexed owner, uint256 amount);
    event AcceptedTokenWithdrawn(address indexed owner, uint256 amount);
    event UnsupportedTokenWithdrawn(address indexed owner, address indexed token, uint256 amount);

    error InvalidToken();
    error InvalidAmount();
    error Paused();
    error InsufficientVaultFunds();
    error UnsupportedToken();
    error NativeTransferFailed();

    constructor(address initialOwner, address token, uint256 deposit, uint256 payout) Ownable(initialOwner) {
        if (initialOwner == address(0) || token == address(0)) revert InvalidToken();
        if (deposit == 0 || payout == 0) revert InvalidAmount();

        acceptedToken = IERC20(token);
        requiredDeposit = deposit;
        payoutAmount = payout;
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    function fund() external payable {
        emit Funded(msg.sender, msg.value);
    }

    function claim() external nonReentrant {
        _claim();
    }

    function claimWithToken(address token) external nonReentrant {
        if (token != address(acceptedToken)) revert UnsupportedToken();
        _claim();
    }

    function pause() external onlyOwner {
        paused = true;
        emit PauseChanged(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit PauseChanged(false);
    }

    function setTerms(uint256 deposit, uint256 payout) external onlyOwner {
        if (deposit == 0 || payout == 0) revert InvalidAmount();

        requiredDeposit = deposit;
        payoutAmount = payout;
        emit TermsUpdated(deposit, payout);
    }

    function withdrawNative(uint256 amount) external onlyOwner nonReentrant {
        if (address(this).balance < amount) revert InsufficientVaultFunds();

        (bool sent, ) = payable(owner()).call{value: amount}("");
        if (!sent) revert NativeTransferFailed();

        emit NativeWithdrawn(owner(), amount);
    }

    function withdrawAcceptedToken(uint256 amount) external onlyOwner nonReentrant {
        acceptedToken.safeTransfer(owner(), amount);
        emit AcceptedTokenWithdrawn(owner(), amount);
    }

    function withdrawUnsupportedToken(address token, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0) || token == address(acceptedToken)) revert UnsupportedToken();

        IERC20(token).safeTransfer(owner(), amount);
        emit UnsupportedTokenWithdrawn(owner(), token, amount);
    }

    function _claim() private {
        if (paused) revert Paused();
        if (address(this).balance < payoutAmount) revert InsufficientVaultFunds();

        acceptedToken.safeTransferFrom(msg.sender, address(this), requiredDeposit);

        (bool sent, ) = payable(msg.sender).call{value: payoutAmount}("");
        if (!sent) revert NativeTransferFailed();

        emit Claimed(msg.sender, requiredDeposit, payoutAmount);
    }
}
