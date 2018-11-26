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
var os = require('os');
var fs = require('fs');
var util = require('util');

let utils = require('fabric-client/lib/utils.js');
let logger = utils.getLogger('HFCInvoke');

/**
 * Class representing a connection to a business network running on Hyperledger
 * Fabric using the Hyperledger fabric node sdk .
 */
class HLFInvoke {
    constructor(cha) {
        logger.info("constructor - init ");

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

        logger.info("constructor - init ");
        // overlay the client profile over the network profile
        this.client = Fabric_Client.loadFromConfig(path.join(__dirname, './config/network-profile.json'));
        this.client.loadFromConfig(path.join(__dirname, './config/client-profile.json'));

        // setup the fabric network - get the channel that was loaded from the network profile
        logger.info("constructor - before getChannel " + cha);
        this.channel = this.client.getChannel(cha);
        logger.info("constructor - before getEventHubsForOrg ");
        this.eventHubs = this.client.getEventHubsForOrg(this.client.getMspid());
        logger.info("constructor - before getCertificateAuthority ");
        this.client.initCredentialStores().then(() => {
            this.caclient = this.client.getCertificateAuthority();
        })

        logger.info("constructor - before config ");
        this.config = require(networkConfig);
        if (this.config.client && this.config.client.organization) {
            orgName = this.config.client.organization;
        } else {
            throw "Organization not found.";
        }
        this.peerName = this.config.organizations[orgName].peers[0]
        logger.info("constructor - peerName = "+this.peerName);

        logger.info("constructor - ok ");
    }
    /**
    * enrollRegistrar 
    *
    * 
    * */
    async enrollRegistrar() {
        var enrollID = '';
        var enrollSecret = '';
        var orgName = '';

        try {
            //search the registrar in the configuration
            logger.info("enrollRegistrar - before search registrar ");
            if (this.config.client && this.config.client.organization) {
                orgName = this.config.client.organization;
            } else {
                throw "Organization not found.";
            }

            var caName = this.config.organizations[orgName].certificateAuthorities[0];
            logger.info("enrollRegistrar - Found organization: " + orgName + " and ca name: " + caName);
            //Retrieve the registar information and enroll it (if it's not already done)
            this.registrar = {};
            if (caName && this.config.certificateAuthorities[caName].registrar[0]) {
                this.registrar.enrollmentID = this.config.certificateAuthorities[caName].registrar[0].enrollId;
                this.registrar.enrollmentSecret = this.config.certificateAuthorities[caName].registrar[0].enrollSecret;
            }
            logger.info("enrollRegistrar - enroll registrar ");
            await this.login(this.registrar.enrollmentID, this.registrar.enrollmentSecret);
            return { rc: 0, message: 'Successfully enrolled' + this.registrar.enrollmentID };

        } catch (err) {
            logger.error("enrollRegistrar - failed",err);
            return { rc: 100, message: 'Enrollement Failed' + this.registrar.enrollmentID };

        }
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

    async invoke(user, chaincodeId, transactionName, transactionArgs) {
        logger.info('invoke - ' + user + ' - ' + chaincodeId + ' - ' + transactionName + ' - ' + transactionArgs);

        var tx_id = null;

        var request = {
            chaincodeId: chaincodeId,
            fcn: transactionName,
            args: [transactionArgs],
            txId: null
        };
        try {

            //load the user who is going to unteract with the network
            logger.info('invoke - before initCredentialStores');
            await this.client.initCredentialStores();
            // get the enrolled user from persistence, this user will sign all requests
            logger.info('invoke - before getUserContext');
            let user_from_store = await this.client.getUserContext(user, true);

            if (user_from_store && user_from_store.isEnrolled()) {
                logger.info('invoke - Successfully loaded user:'+ user+' from persistence');
            } else {
                throw new Error('invoke - Failed to get user:' + user);
            }

            logger.info('invoke - before newTransactionID');
            // get a transaction id object based on the current user assigned to fabric client
            tx_id = this.client.newTransactionID();
            request.txId = tx_id
            logger.info("invoke - Assigning transaction_id: ", tx_id._transaction_id);
            logger.info('invoke - request.chaincodeId=' + request.chaincodeId + ' request.fcn=' + request.fcn + ' request.args=' + request.args + ' request.txId=' + request.txId);

            // send the transaction proposal to the endorsing peers
            let results = await this.channel.sendTransactionProposal(request);
   
            var proposalResponses = results[0];
            var proposal = results[1];
            let isProposalGood = false;
            if (proposalResponses && proposalResponses[0].response &&
                proposalResponses[0].response.status === 200) {
                isProposalGood = true;
                logger.info('Transaction proposal was good');
            } else {
                logger.info('Transaction proposal was bad ' + proposalResponses[0].response.status);
            }
            if (isProposalGood) {
                logger.info(
                    'Successfully sent Proposal and received ProposalResponse: Status - ' + proposalResponses[0].response.status + ', message - ' +
                    proposalResponses[0].response.message);

                // build up the request for the orderer to have the transaction committed
                var request = {
                    proposalResponses: proposalResponses,
                    proposal: proposal
                };

                // set the transaction listener and set a timeout of 30 sec
                // if the transaction did not get committed within the timeout period,
                // report a TIMEOUT status
                var transaction_id_string = tx_id.getTransactionID(); //Get the transaction ID string to be used by the event processing
                var promises = [];

                var sendPromise = await this.channel.sendTransaction(request);
                promises.push(sendPromise); //we want the send transaction first, so that we know where to check status

                // get an eventhub once the fabric client has a user assigned. The user
                // is required bacause the event registration must be signed
                logger.info('Getting event hub');
                let event_hub = this.channel.newChannelEventHub(this.peerName);

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

                results = await Promise.all(promises);
                logger.info('After Promise.all : result= ' + util.inspect(results))
            } else {
                logger.error('Failed to send Proposal or receive valid response. Response null or status is not 200. exiting...');
                throw new Error('Failed to send Proposal or receive valid response. Response null or status is not 200. exiting...');
            }

            logger.info('Send transaction promise and event listener promise have completed');
            // check the results in the order the promises were added to the promise all list
            if (results && results[0] && results[0].status === 'SUCCESS') {
                logger.info('Successfully sent transaction to the orderer.');
            } else {
                logger.error('Failed to order the transaction. Error code: ' + results.status);
            }

            if (results && results[1] && results[1].event_status === 'VALID') {
                logger.info('Successfully committed the change to the ledger by the peer');
                return { rc: 0, message: 'Successfully committed the change to the ledger by the peer', txid: tx_id.getTransactionID() };

            } else {
                logger.info('Transaction failed to be committed to the ledger due to ::' + results[1].event_status);
                return { rc: 100, message: 'Transaction failed to be committed to the ledger due to ::', details: results[1].event_status };
            }
        }
        catch (err) {
            logger.error('Failed to invoke successfully :: ' + err);
            return { rc: 100, message: 'Failed to invoke successfully :: ', details: err };
        }
    }

    /**
    * Retrieve the credentials of the user, and if doesn't exist, enroll the user  
    *    
    * 
    * */
    async login(userName, secret) {
        logger.info("login - " + userName + "/" + secret);
        try {
            //load the user who is going to interact with the network
            await this.client.initCredentialStores();

            logger.info("login - after initCredentialStores " + userName);
            // first check to see if the admin is already enrolled
            let user = await this.client.getUserContext(userName, true);

            logger.info("login - after getUserContext" + user);
            if (user && user.isEnrolled()) {
                logger.info('login - Successfully loaded user from persistence');
            } else {
                let enrollment = await this.caclient.enroll({ enrollmentID: userName, enrollmentSecret: secret });
                logger.info('login - Successfully enrolled member user "' + userName + '" with msp: "' + this.client.getMspid() + '"');
                user = await this.client.createUser(
                    {
                        username: userName,
                        mspid: this.client.getMspid(),
                        cryptoContent: { privateKeyPEM: enrollment.key.toBytes(), signedCertPEM: enrollment.certificate }
                    });
            }
            logger.info('login - setUserContext');
            return await this.client.setUserContext(user);

        } catch (error) {
            logger.error("login - " + error);

        }
    }


    /**
     * registerUser 
     *      
     *  
     * 
     * */
    async registerUser(userName, affil = 'org1.department1', businessrole) {
        var userName = 'user1';
        var fabric_ca_client = null;

        //load the user who is going to interact with the network
        await this.client.initCredentialStores().then(() => {
            // first check to see if the admin is already enrolled
            return this.client.getUserContext(this.registrar.admin_user, true);
        }).then((admin_user) => {
            if (admin_user && admin_user.isEnrolled()) {
                console.log('Successfully loaded admin from persistence');
            } else {
                throw new Error('Failed to get admin.... run enrollAdminNetwork.js');
            }
            // at this point we should have the admin user so now register the user with the CA server
            return this.caclient.register({ enrollmentID: userName, affiliation: affil, role: 'client', }, admin_user);
        }).then((secret) => {
            // next we need to enroll the user with CA server
            console.log('Successfully registered "' + userName + '" - with secret:' + secret);

            return enrollUser(userName, secret);
        }).then(() => {
            console.log('"' + userName + '" was successfully registered and enrolled and is ready to interact with the fabric network');
        }).catch((err) => {
            console.error('Failed to register: ' + err);
            if (err.toString().indexOf('Authorization') > -1) {
                console.error('Authorization failures may be caused by having admin credentials from a previous CA instance.\n' +
                    'Try again after deleting the contents of the store directory hfc-key-store');
            }
        });
    }
}

module.exports = HLFInvoke;