var request = require('sync-request');
var LineReaderSync = require("line-reader-sync")

var fs = require('fs');

/**
 * Put your settings here:
 *     - address: the address of your node that you want to distribute from
 *     - alias: the alias of the node address
 *     - startBlockHeight: the block from which you want to start distribution for
 *     - endBlock: the block until you want to distribute the earnings
 *     - distributableNATAPerBlock: amount of NATA distributed per forged block
 *     - filename: file to which the payments for the mass payment tool are written
 *     - node: address of your node in the form http://<ip>:<port
 *     - percentageOfFeesToDistribute: the percentage of Waves fees that you want to distribute
 *     - blockStorage: file for storing block history
 */
var config = {
    address: '3Jcz4rj98NUQAgEr3BVXaEvrSBVQ8eHb3F4',
    alias: 'natapoints',
    startBlockHeight: 149634,
    endBlock: 199654,
    distributableNATAPerBlock: 10,
    filename: 'payment.json',
    node: 'http://173.249.45.183:6861',
    percentageOfFeesToDistribute: 90,
    blockStorage: 'blocks.json'
};

var payments = [];
var nata = [];
var myLeases = {};
var myCanceledLeases = {};
var myForgedBlocks = [];

/**
 * This method starts the overall process by first downloading the blocks,
 * preparing the necessary datastructures and finally preparing the payments
 * and serializing them into a file that could be used as input for the
 * masspayment tool.
 */
var start = function() {
    console.log('getting blocks...');
    var blocks = getAllBlocks();
    if (fs.existsSync(config.blockStorage)) {
        fs.unlinkSync(config.blockStorage);
    }
    console.log('preparing datastructures...');
    prepareDataStructure(blocks);
    blocks.forEach(function(block) {
        var transactions = [];

        if (block.height < config.startBlockHeight) {
            block.transactions.forEach(function(tx) {
                if (tx.type === 8 || tx.type === 9) {
                    transactions.push(tx);
                }
            });
        } else {
            transactions = block.transactions;
        }

        var blockInfo = {
            height: block.height,
            generator: block.generator,
            TNFees: block.TNFees,
            previousBlockTNFees: block.previousBlockTNFees,
            transactions: transactions
        };
        fs.appendFileSync(config.blockStorage, JSON.stringify(blockInfo) + '\n');
    });
    console.log('preparing payments...');
    myForgedBlocks.forEach(function(block) {
        if (block.height >= config.startBlockHeight && block.height <= config.endBlock) {
            var blockLeaseData = getActiveLeasesAtBlock(block);
            var activeLeasesForBlock = blockLeaseData.activeLeases;
            var amountTotalLeased = blockLeaseData.totalLeased;

            distribute(activeLeasesForBlock, amountTotalLeased, block);
        }
    });
    pay();
};

/**
 * This method organizes the datastructures that are later on necessary
 * for the block-exact analysis of the leases.
 *
 *   @param blocks all blocks that should be considered
 */
var prepareDataStructure = function(blocks) {
    var previousBlock;
    blocks.forEach(function(block) {
        var TNFees = 0;

        if (block.generator === config.address) {
            myForgedBlocks.push(block);
        }

        block.transactions.forEach(function(transaction) {
            // type 8 are leasing tx
            if (transaction.type === 8 && (transaction.recipient === config.address || transaction.recipient === "address:" + config.address || transaction.recipient === 'alias:L:' + config.alias)) {
                transaction.block = block.height;
                myLeases[transaction.id] = transaction;
            } else if (transaction.type === 9 && myLeases[transaction.leaseId]) { // checking for lease cancel tx
                transaction.block = block.height;
                myCanceledLeases[transaction.leaseId] = transaction;
            }
            // considering TN fees
            if (!transaction.feeAsset || transaction.feeAsset === '' || transaction.feeAsset === null) {
                if (transaction.fee < 10 * Math.pow(10, 8)) {
                    TNFees += transaction.fee;
                }
            } else if (block.height > 100000 && transaction.type === 4) {
                TNFees += 2000000;
            }
        });
        if (previousBlock) {
            block.previousBlockTNFees = previousBlock.TNFees;
        }
        block.TNFees = TNFees;
        previousBlock = block;
    });
};

/**
 * Method that returns all relevant blocks.
 *
 * @returns {Array} all relevant blocks
 */
var getAllBlocks = function() {
    // leases have been resetted in block 462000, therefore, this is the first relevant block to be considered
    var firstBlockWithLeases = 149634;
    var currentStartBlock = firstBlockWithLeases;
    var blocks = [];
    var steps = 100;

    if (fs.existsSync(config.blockStorage)) {
        lrs = new LineReaderSync(config.blockStorage);

        var lineFound = true;
        while(lineFound){
            var line = lrs.readline()
            if(line){
                blocks.push(JSON.parse(line));
            } else {
                lineFound = false;
            }
        }

        currentStartBlock = blocks[blocks.length - 1].height + 1;
        console.log('retrieved blocks from ' + blocks[0].height + ' to ' + (currentStartBlock - 1));
    }

    while (currentStartBlock < config.endBlock) {
        var currentBlocks;

        if (currentStartBlock + (steps - 1) < config.endBlock) {
            console.log('getting blocks from ' + currentStartBlock + ' to ' + (currentStartBlock + (steps - 1)));
            var res = request('GET', config.node + '/blocks/seq/' + currentStartBlock + '/' + (currentStartBlock + (steps - 1)), {
                'headers': {
                    'Connection': 'keep-alive'
                }
            });
            if (res.body) {
                var blocksJSON = res.body.toString();
                currentBlocks = JSON.parse(blocksJSON);
            } else {
                currentBlocks = [];
            }
        } else {
            console.log('getting blocks from ' + currentStartBlock + ' to ' + config.endBlock);
            currentBlocks = JSON.parse(request('GET', config.node + '/blocks/seq/' + currentStartBlock + '/' + config.endBlock, {
                'headers': {
                    'Connection': 'keep-alive'
                }
            }).getBody('utf8'));
        }
        if (currentBlocks.length > 0) {
            currentBlocks.forEach(function(block) {
                if (block.height <= config.endBlock) {
                    blocks.push(block);
                }
            });

            if (currentStartBlock + steps < config.endBlock) {
                currentStartBlock += steps;
            } else {
                currentStartBlock = config.endBlock;
            }
        }
    }

    return blocks;
};

/**
 * This method distributes either TN fees and NATA to the active leasers for
 * the given block.
 *
 * @param activeLeases active leases for the block in question
 * @param amountTotalLeased total amount of leased TN in this particular block
 * @param block the block to consider
 */
var distribute = function(activeLeases, amountTotalLeased, block, previousBlock) {
    var fee;

    if (block.height >= 149634) {
        fee = block.TNFees * 0.4 + block.previousBlockTNFees * 0.6;
    } else {
        fee = block.TNFees
    }

    for (var address in activeLeases) {
        var share = (activeLeases[address] / amountTotalLeased)
        var amount = fee * share;
        var amountNATA = share * config.distributableNATAPerBlock;

        if (payments[address]) {
            payments[address] += amount * (config.percentageOfFeesToDistribute / 100);
            nata[address] += amountNATA;
        } else {
            payments[address] = amount * (config.percentageOfFeesToDistribute / 100);
            nata[address] = amountNATA;
        }
    }
};

/**
 * Method that creates the concrete payment tx and writes it to the file
 * configured in the config section.
 */
var pay = function() {
    var transactions = [];
    for (var address in payments) {
        var payment = (payments[address] / Math.pow(10, 8));

        if (payment > 0) {
            transactions.push({
                "amount": Number(Math.round(payments[address])),
                "fee": 2000000,
                "sender": config.address,
                "attachment": "NpLmsir2hcRAdcRS9EsZUA9HA1rdbz",
                "recipient": address
            });
        }
        if (nata[address] > 0) {
            transactions.push({
                "amount": Number(Math.round(nata[address] * Math.pow(10, 2))),
                "fee": 2000000,
                "sender": config.address,
                "attachment": "NpLmsir2hcRAdcRS9EsZUA9HA1rdbz",
                "recipient": address
            });
        }
    }
    fs.writeFile(config.filename, JSON.stringify(transactions), {}, function(err) {
        if (!err) {
            console.log('payments written to ' + config.filename + '!');
        } else {
            console.log(err);
        }
    });
};

/**
 * This method returns (block-exact) the active leases and the total amount
 * of leased Waves for a given block.
 *
 * @param block the block to consider
 * @returns {{totalLeased: number, activeLeases: {}}} total amount of leased waves and active leases for the given block
 */
var getActiveLeasesAtBlock = function(block) {
    var activeLeases = [];
    var totalLeased = 0;
    var activeLeasesPerAddress = {};

    for (var leaseId in myLeases) {
        var currentLease = myLeases[leaseId];

        if (!myCanceledLeases[leaseId] || myCanceledLeases[leaseId].block > block.height) {
            activeLeases.push(currentLease);
        }
    }
    activeLeases.forEach(function (lease) {
        if (block.height > lease.block + 1000) {
            if (!activeLeasesPerAddress[lease.sender]) {
                activeLeasesPerAddress[lease.sender] = lease.amount;
            } else {
                activeLeasesPerAddress[lease.sender] += lease.amount;
            }

            totalLeased += lease.amount;
        }
    });

    return { totalLeased: totalLeased, activeLeases: activeLeasesPerAddress };
};

start();
