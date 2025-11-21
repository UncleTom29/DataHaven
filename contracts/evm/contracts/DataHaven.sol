// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol"; 

contract DataHaven {
    address public admin;
    address public relayer;
    uint256 public requestCount;
    bool public paused;

    uint256 public constant MIN_PAYMENT = 0.001 ether;

    enum Status { Pending, Confirmed, Failed, Revoked }

    struct Request {
        address user;
        bytes32 dataHash;
        bytes32 blobId; 
        bytes32 suiTxHash; 
        bytes32 proofHash; 
        Status status;
        uint256 payment;
        uint256 timestamp;
    }

    mapping(bytes32 => Request) public requests;

    event StorageRequested(
        bytes32 indexed requestId,
        address indexed user,
        bytes32 dataHash,
        uint256 payment,
        uint256 timestamp
    );

    event StorageConfirmed(
        bytes32 indexed requestId,
        bytes32 blobId,
        bytes32 suiTxHash,
        bytes32 proofHash
    );
    event RequestFailed(bytes32 indexed requestId);
    event AccessRevoked(bytes32 indexed requestId);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Not admin");
        _;
    }

    modifier onlyRelayer() {
        require(msg.sender == relayer, "Not relayer");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Paused");
        _;
    }

    constructor(address _relayer) {
        admin = msg.sender;
        relayer = _relayer;
    }

    function initiateStorage(bytes32 _dataHash) 
        external 
        payable 
        whenNotPaused 
        returns (bytes32) 
    {
        require(msg.value >= MIN_PAYMENT, "Insufficient payment");
        
        bytes32 requestId = keccak256(
            abi.encodePacked(msg.sender, _dataHash, requestCount++, block.timestamp)
        );

        requests[requestId] = Request({
            user: msg.sender,
            dataHash: _dataHash,
            blobId: bytes32(0),
            suiTxHash: bytes32(0),
            proofHash: bytes32(0),
            status: Status.Pending,
            payment: msg.value,
            timestamp: block.timestamp
        });

        emit StorageRequested(requestId, msg.sender, _dataHash, msg.value, block.timestamp);
        return requestId;
    }

    // New: Replaces confirmStorage for workflow step 4
        function verifyReceipt(
            bytes32 _requestId,
            bytes32 _blobId,
            bytes32 _suiTxHash,
            bytes32 _proofHash,
            bytes memory _signature
        ) external {
            Request storage req = requests[_requestId];
            require(req.status == Status.Pending, "Invalid status");
    
            // Verify signature from relayer
            bytes32 messageHash = keccak256(abi.encodePacked(_requestId, _blobId, _suiTxHash, _proofHash));
            // Manually compute the Ethereum Signed Message hash since toEthSignedMessageHash isn't available
            bytes32 ethSignedMessageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
            address signer = ECDSA.recover(ethSignedMessageHash, _signature);
            require(signer == relayer, "Invalid signature");
    
            // Update request
            req.blobId = _blobId;
            req.suiTxHash = _suiTxHash;
            req.proofHash = _proofHash;
            req.status = Status.Confirmed;
    
            emit StorageConfirmed(_requestId, _blobId, _suiTxHash, _proofHash);
        }

    function markFailed(bytes32 _requestId) external onlyRelayer {
        Request storage req = requests[_requestId];
        require(req.status == Status.Pending, "Invalid status");
        
        req.status = Status.Failed;
        payable(req.user).transfer(req.payment);
        
        emit RequestFailed(_requestId);
    }

    function revokeAccess(bytes32 _requestId) external {
        Request storage req = requests[_requestId];
        require(req.user == msg.sender, "Not owner");
        require(req.status == Status.Confirmed, "Not confirmed");
        
        req.status = Status.Revoked;
        emit AccessRevoked(_requestId);
    }

    function pause() external onlyAdmin { paused = true; }
    function unpause() external onlyAdmin { paused = false; }
    function updateRelayer(address _relayer) external onlyAdmin { relayer = _relayer; }
    function withdraw(uint256 _amount) external onlyAdmin { payable(admin).transfer(_amount); }
    
    receive() external payable {}
}