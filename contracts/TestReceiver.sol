// SPDX-License-Identifier: MIT
pragma solidity ^0.4.18;

/// @notice Test helper contract to verify ERC223 tokenFallback calls
contract TestReceiver {
    event Received(address indexed from, uint256 value, bytes data);

    function tokenFallback(address _from, uint _value, bytes _data) public {
        Received(_from, _value, _data);
    }
}
