'use strict';
/*
* Copyright IBM Corp All Rights Reserved
*
* SPDX-License-Identifier: Apache-2.0
*/
/*
 * Chaincode Invoke
 */

var Fabric_Client = require('fabric-client');
var path = require('path');
var util = require('util');
var os = require('os');
var fs = require('fs');

let utils = require('fabric-client/lib/utils.js');
let logger = utils.getLogger('HFCInvoke');

/**
 * Class representing a connection to a business network running on Hyperledger
 * Fabric using the Hyperledger fabric node sdk .
 */
class HLFInvoke {
    constructor(cha) {

        //make sure we have the profiles we need
        var networkConfig = path.join(__dirname, './config/network-profile.json');
        var clientConfig = path.join(__dirname, './config/client-profile.json');
        if (!fs.existsSync(networkConfig)) {
            logger.error("Error: config file 'network-profile.json' not found.");
            logger.error("Make sure 'network-profile.json' is copied into the './config' folder.");
            process.exit()
        }
        if (!fs.existsSync(clientConfig)) {
            logger.error("Error: config file 'client-profile.json' not found.");
            logger.error("Make sure 'client-profile.json' is copied into the './config' folder.");
            process.exit()
        }

        // load the base network profile
        this.client = Fabric_Client.loadFromConfig(path.join(__dirname, './config/network-profile.json'));

        // overlay the client profile over the network profile
        this.client.loadFromConfig(path.join(__dirname, './config/client-profile.json'));

        // setup the fabric network - get the channel that was loaded from the network profile
        this.channel = this.client.getChannel(cha);
        this.eventHubs = this.client.getEventHubsForOrg(this.client.getMspid());

    }
    /**
     * Invoke a "invoke" chaincode as described in the request object.  
     *               request =   {
     *                   chaincodeId: 'chaincodename',
     *                   fcn: 'function of the chaincode',
     *                   args: [ param1, param2 ],
     *                   txId: tx_id
     *               };
     *
     *   tx_id should be created before.  It can be done using the getTxId() call or getAdminTxId()
     *
     *  The call is synchonous.  It returns an array.  First member is the returned message and the second member is the return code.
     *  0 indicates a sucessful transaction
     * 
     * */

    async  invoke(user, chaincodeId, transactionName, transactionArgs) {

        var tx_id = null;

        var request = {
            chaincodeId: chaincodeId,
            fcn: transactionName,
            args: [transactionArgs],
            txId: nil
        };

        //load the user who is going to unteract with the network
        this.client.initCredentialStores().then(() => {
            // get the enrolled user from persistence, this user will sign all requests
            return this.client.getUserContext(user, true);
        }).then((user_from_store) => {
            if (user_from_store && user_from_store.isEnrolled()) {
                logger.info('Successfully loaded admin from persistence');

            } else {
                throw new Error('Failed to get user1.... run registerUserNetwork.js');
            }

            // get a transaction id object based on the current user assigned to fabric client
            tx_id = this.client.newTransactionID();
            request.txId = tx_id
            logger.info("Assigning transaction_id: ", tx_id._transaction_id);

            // send the transaction proposal to the endorsing peers
            return channel.sendTransactionProposal(request);
        }).then((results) => {
            var proposalResponses = results[0];
            var proposal = results[1];
            let isProposalGood = false;
            if (proposalResponses && proposalResponses[0].response &&
                proposalResponses[0].response.status === 200) {
                isProposalGood = true;
                logger.info('Transaction proposal was good');
            } else {
                logger.info('Transaction proposal was bad');
            }
            if (isProposalGood) {
                logger.info(util.format(
                    'Successfully sent Proposal and received ProposalResponse: Status - %s, message - "%s"',
                    proposalResponses[0].response.status, proposalResponses[0].response.message));

                // build up the request for the orderer to have the transaction committed
                var request = {
                    proposalResponses: proposalResponses,
                    proposal: proposal
                };

                // set the transaction listener and set a timeout of 30 sec
                // if the transaction did not get committed within the timeout period,
                // report a TIMEOUT status
                var transaction_id_string = request.tx_id.getTransactionID(); //Get the transaction ID string to be used by the event processing
                var promises = [];

                var sendPromise = channel.sendTransaction(request);
                promises.push(sendPromise); //we want the send transaction first, so that we know where to check status

                // get an eventhub once the fabric client has a user assigned. The user
                // is required bacause the event registration must be signed
                logger.error('Getting event hub');


                let event_hub = channel.newChannelEventHub('org1-peer1');

                // using resolve the promise so that result status may be processed
                // under the then clause rather than having the catch clause process
                // the status
                let txPromise = new Promise((resolve, reject) => {
                    let handle = setTimeout(() => {
                        event_hub.disconnect();
                        resolve({ event_status: 'TIMEOUT' }); //we could use reject(new Error('Trnasaction did not complete within 30 seconds'));
                    }, 3000);
                    event_hub.connect();
                    event_hub.registerTxEvent(transaction_id_string, (tx, code) => {
                        // this is the callback for transaction event status
                        // first some clean up of event listener
                        clearTimeout(handle);
                        event_hub.unregisterTxEvent(transaction_id_string);
                        event_hub.disconnect();

                        // now let the application know what happened
                        var return_status = { event_status: code, tx_id: transaction_id_string };
                        if (code !== 'VALID') {
                            logger.error('The transaction was invalid, code = ' + code);
                            resolve(return_status); // we could use reject(new Error('Problem with the tranaction, event status ::'+code));
                        } else {
                            logger.info('The transaction has been committed on peer ' + event_hub.getPeerAddr());
                            resolve(return_status);
                        }
                    }, (err) => {
                        //this is the callback if something goes wrong with the event registration or processing
                        reject(new Error('There was a problem with the eventhub ::' + err));
                    });
                });
                promises.push(txPromise);

                return Promise.all(promises);
            } else {
                logger.error('Failed to send Proposal or receive valid response. Response null or status is not 200. exiting...');
                throw new Error('Failed to send Proposal or receive valid response. Response null or status is not 200. exiting...');
            }
        }).then((results) => {
            logger.log('Send transaction promise and event listener promise have completed');
            // check the results in the order the promises were added to the promise all list
            if (results && results[0] && results[0].status === 'SUCCESS') {
                logger.info('Successfully sent transaction to the orderer.');
            } else {
                logger.error('Failed to order the transaction. Error code: ' + response.status);
            }

            if (results && results[1] && results[1].event_status === 'VALID') {
                logger.info('Successfully committed the change to the ledger by the peer');
                return { rc: 0, message: 'Successfully committed the change to the ledger by the peer', txid: tx_id.getTransactionID() };

            } else {
                logger.info('Transaction failed to be committed to the ledger due to ::' + results[1].event_status);
                return { rc: 100, message: 'Transaction failed to be committed to the ledger due to ::', details: results[1].event_status };
            }
        }).catch((err) => {
            logger.error('Failed to invoke successfully :: ' + err);
            return { rc: 100, message: 'Failed to invoke successfully :: ', details: err };
        });
    }

}
module.exports = HLFInvoke;