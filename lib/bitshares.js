import Event from "./event.js"
import Asset from "./asset.js"
import Account from "./account.js"
import Api from "./api.js"
import Fees from "./fees.js"
import Transaction from "./transaction.js"
import { LZMA as lzma } from "lzma/src/lzma-d-min"
import BigNumber from "bignumber.js"
import { PrivateKey, PublicKey, Login, Aes } from "bitsharesjs"

class BitShares {
  static node = "wss://bitshares.openledger.info/ws"
  static autoreconnect = true
  static logger = console

  static subscribe = Event.subscribe
  static generateKeys = Login.generateKeys.bind(Login)
  
  static async connect(node, autoreconnect = BitShares.autoreconnect) {
    if (BitShares.connectPromise || BitShares.connectedPromise)
      return Promise.all([BitShares.connectPromise, BitShares.connectedPromise]);

    if (autoreconnect)
      Api.getApis().setRpcConnectionStatusCallback(BitShares.statusCallBack)

    await (BitShares.connectPromise = BitShares.reconnect(node));
    await (BitShares.connectedPromise = BitShares.connectedInit());

    Event.connectedNotify()

    return true;
  }

  static disconnect() {
    BitShares.connectPromise = BitShares.connectedPromise = undefined
    BitShares.autoreconnect = false
    Api.getApis().close()
  }

  static async reconnect(node = BitShares.node) {
    let res = await Api.getApis().instance(node, true).init_promise;
    BitShares.chain = res[0].network;
    BitShares.node = node

    return res;
  }

  static statusCallBack(status) {
    BitShares.logger.log("WebSocket status:", status)
    if (BitShares.autoreconnect && status === 'closed') {
      BitShares.logger.log("WebSocket status, try to connect...");
      setTimeout(() => {
        BitShares.reconnect().then(Event.resubscribe.bind(Event)).catch(BitShares.logger.error)
      }, 2000)
    }
  }

  static async connectedInit() {
    if (!this.connectPromise || this.blockReCall)
      return

    this.blockReCall = true

    this.db = Api.new('db_api');
    this.history = Api.new('history_api');
    this.network = Api.new('network_api');
    //this.crypto = Api.new('crypto_api');

    Transaction.setDB(this.db);
    this.newTx = Transaction.newTx;

    this.assets = Asset.init(this.db);
    this.accounts = Account.init(this.db);
    this.fees = Fees.init(this.db);
    await this.fees.update();
  }

  static async login(accountName, password, feeSymbol = BitShares.chain.core_asset) {
    let
      acc = await BitShares.accounts[accountName],
      activeKey = PrivateKey.fromSeed(`${accountName}active${password}`),
      genPubKey = activeKey.toPublicKey().toString();

    if (genPubKey != acc.active.key_auths[0][0])
      throw new Error("The pair of login and password do not match!")

    let account = new BitShares(accountName, activeKey.toWif(), feeSymbol);

    account.setMemoKey((acc.options.memo_key === genPubKey ? activeKey : PrivateKey.fromSeed(`${accountName}memo${password}`)).toWif())

    await account.initPromise;
    return account
  }

  static async loginFromFile(buffer, password, accountName, feeSymbol = BitShares.chain.core_asset) {
    let backup_buffer = Aes.decrypt_with_checksum(
      PrivateKey.fromSeed(password),
      PublicKey.fromBuffer(buffer.slice(0, 33)),
      null /*nonce*/,
      buffer.slice(33)
    );

    let
      buffer_data = JSON.parse(lzma.decompress(backup_buffer)),
      wallet = buffer_data.wallet[0],
      password_aes = Aes.fromSeed(password),
      encryption_plainbuffer = password_aes.decryptHexToBuffer(wallet.encryption_key),
      aes_private = Aes.fromSeed(encryption_plainbuffer);

    let acc = await BitShares.accounts[accountName];
    let accKey = buffer_data.private_keys.find(key => key.pubkey === acc.active.key_auths[0][0])

    if (!accKey)
      throw new Error(`Not found active key for account ${accountName}`);

    let private_key_hex = aes_private.decryptHex(accKey.encrypted_key);
    let activeKey = PrivateKey.fromBuffer(new Buffer(private_key_hex, "hex"));

    let account = new BitShares(accountName, activeKey.toWif(), feeSymbol);

    let memoKey;
    if (acc.options.memo_key === acc.active.key_auths[0][0])
      memoKey = activeKey
    else {
      accKey = buffer_data.private_keys.find(key => key.pubkey === acc.options.memo_key)

      if (!accKey) {
        private_key_hex = aes_private.decryptHex(accKey.encrypted_key);
        memoKey = PrivateKey.fromBuffer(new Buffer(private_key_hex, "hex"));
      }
    }

    memoKey && account.setMemoKey(memoKey.toWif())

    await account.initPromise;
    return account
  }

  static ticker(baseSymbol, quoteSymbol) {
    return BitShares.db.get_ticker(baseSymbol.toUpperCase(), quoteSymbol.toUpperCase())
  }

  static async tradeHistory(quoteSymbol, baseSymbol, startDate, stopDate, bucketSeconds) {
    return BitShares.history.get_market_history(
      (await BitShares.assets[quoteSymbol]).id,
      (await BitShares.assets[baseSymbol]).id,
      bucketSeconds,
      startDate.toISOString().slice(0, -5),
      stopDate.toISOString().slice(0, -5)
    )
  }

  static async getLimitOrders(quoteSymbol, baseSymbol, limit = 50) {
    return BitShares.db.get_limit_orders(
      (await BitShares.assets[quoteSymbol]).id,
      (await BitShares.assets[baseSymbol]).id,
      limit > 100 ? 100 : limit
    )
  }

  static async getOrderBook(quoteSymbol, baseSymbol, limit = 50) {
    return BitShares.db.get_order_book(
      (await BitShares.assets[quoteSymbol]).id,
      (await BitShares.assets[baseSymbol]).id,
      limit > 50 ? 50 : limit
    )
  }

  constructor(accountName, activeKey, feeSymbol = BitShares.chain.core_asset) {
    if (activeKey)
      this.activeKey = PrivateKey.fromWif(activeKey);

    this.newTx = () => {
      return Transaction.newTx([this.activeKey])
    }

    this.initPromise = Promise.all([
      BitShares.accounts[accountName],
      BitShares.assets[feeSymbol]
    ]).then(params => {
      [this.account, this.feeAsset] = params;
    })
  }

  setFeeAsset = async feeSymbol => {
    await this.initPromise;
    this.feeAsset = await BitShares.assets[feeSymbol]
  }

  setMemoKey = memoKey => {
    this.memoKey = PrivateKey.fromWif(memoKey);
  }

  broadcast = (tx, keys = [this.activeKey]) => {
    return tx.broadcast(keys)
  }

  sendOperation = operation => {
    let tx = this.newTx()
    tx.add(operation)
    return tx.broadcast()
  }

  balances = async (...args) => {
    await this.initPromise;

    let assets = await Promise.all(args
      .map(async asset => (await BitShares.assets[asset]).id));
    let balances = await BitShares.db.get_account_balances(this.account.id, assets);
    return Promise.all(balances.map(balance => BitShares.assets.fromParam(balance)))
  }

  buyOperation = async (buySymbol, baseSymbol, amount, price, fill_or_kill = false, expire = "2020-02-02T02:02:02") => {
    await this.initPromise;

    let buyAsset = await BitShares.assets[buySymbol],
        baseAsset = await BitShares.assets[baseSymbol],
        buyAmount = Math.floor(amount * 10 ** buyAsset.precision),
        sellAmount = Math.floor(BigNumber(amount).times(price * 10 ** baseAsset.precision).toString());

    if (buyAmount == 0 || sellAmount == 0)
      throw new Error("Amount equal 0!")

    let params = {
      fee: this.feeAsset.toParam(),
      seller: this.account.id,
      amount_to_sell: baseAsset.toParam(sellAmount),
      min_to_receive: buyAsset.toParam(buyAmount),
      expiration: expire,
      fill_or_kill: fill_or_kill,
      extensions: []
    }

    return { limit_order_create: params }
  }

  buy = async (...args) => {
    let tx = await this.sendOperation(
      await this.buyOperation(...args)
    )
    return (await BitShares.db.get_objects([tx[0].trx.operation_results[0][1]]))[0];
  }

  sellOperation = async (sellSymbol, baseSymbol, amount, price, fill_or_kill = false, expire = "2020-02-02T02:02:02") => {
    await this.initPromise;

    let sellAsset = await BitShares.assets[sellSymbol],
        baseAsset = await BitShares.assets[baseSymbol],
        sellAmount = Math.floor(amount * 10 ** sellAsset.precision),
        buyAmount = Math.floor(BigNumber(amount).times(price * 10 ** baseAsset.precision).toString());

    if (buyAmount == 0 || sellAmount == 0)
      throw new Error("Amount equal 0!")

    let params = {
      fee: this.feeAsset.toParam(),
      seller: this.account.id,
      amount_to_sell: sellAsset.toParam(sellAmount),
      min_to_receive: baseAsset.toParam(buyAmount),
      expiration: expire,
      fill_or_kill: fill_or_kill,
      extensions: []
    }
  
    return {limit_order_create: params }
  }

  sell = async (...args) => {
    let tx = await this.sendOperation(
      await this.sellOperation(...args)
    )
    return (await BitShares.db.get_objects([tx[0].trx.operation_results[0][1]]))[0];
  }

  orders = async () => {
    await this.initPromise;
    return (await BitShares.db.get_full_accounts([this.account.id],false))[0][1].limit_orders
  }

  getOrder = async id => {
    await this.initPromise;
    return (await BitShares.db.get_objects([id]))[0];
  }

  cancelOrderOperation = async id => {
    await this.initPromise;

    let params = {
      fee: this.feeAsset.toParam(),
      fee_paying_account: this.account.id,
      order: id,
      extensions: []
    }

    return { limit_order_cancel: params }
  }

  cancelOrder = async (...args) => {
    return this.sendOperation(
      await this.cancelOrderOperation(...args)
    )
  }

  memo = async (toName, message) => {
    if (!this.memoKey)
      throw new Error("Not set memoKey!");

    let nonce = Date.now().toString(), //TransactionHelper.unique_nonce_uint64(),
        to = (await BitShares.accounts[toName]).options.memo_key;

    return {
      from: this.memoKey.toPublicKey().toPublicKeyString(),
      to,
      nonce,
      message: Aes.encrypt_with_checksum(this.memoKey, to, nonce, new Buffer(message, "utf-8"))
    }
  }

  memoDecode = memos => {
    if (!this.memoKey)
      throw new Error("Not set memoKey!");

    return Aes.decrypt_with_checksum(this.memoKey, memos.from, memos.nonce, memos.message)
      .toString("utf-8");
  }

  transferOperation = async (toName, assetSymbol, amount, memo) => {
    await this.initPromise;

    let asset = await BitShares.assets[assetSymbol],
        intAmount = Math.floor(amount * 10 ** asset.precision);

    if (intAmount == 0)
      throw new Error("Amount equal 0!")

    let params = {
      fee: this.feeAsset.toParam(),
      from: this.account.id,
      to: (await BitShares.accounts[toName]).id,
      amount: asset.toParam(intAmount),
      extensions: []
    };

    if (memo)
      params.memo = (typeof memo == "string") ? (await this.memo(toName, memo)) : memo;

    return { transfer: params }
  }

  transfer = async (...args) => {
    return this.sendOperation(
      await this.transferOperation(...args)
    )
  }

  assetIssueOperation = async (toName, assetSymbol, amount, memo) => {
    await this.initPromise;

    let asset = await BitShares.assets[assetSymbol],
        intAmount = Math.floor(amount * 10 ** asset.precision);

    if (intAmount === 0)
      throw new Error("Amount equal 0!");

    let params = {
      fee: this.feeAsset.toParam(),
      issuer: this.account.id,
      asset_to_issue: asset.toParam(intAmount),
      issue_to_account: (await BitShares.accounts[toName]).id
    };

    if (memo)
      params.memo = (typeof memo === "string") ? (await this.memo(toName, memo)) : memo;

    return { asset_issue: params }
  }

  assetIssue = async (...args) => {
    return this.sendOperation(
      await this.assetIssueOperation(...args)
    )
  }

  assetReserveOperation = async (assetSymbol, amount) => {
    await this.initPromise;

    let payer = this.account.id;

    let asset = await BitShares.assets[assetSymbol],
        intAmount = Math.floor(amount * 10 ** asset.precision);

    if (intAmount === 0)
      throw new Error("Amount equal 0!");

    let params = {
      fee: this.feeAsset.toParam(),
      amount_to_reserve: asset.toParam(intAmount),
      payer,
      extensions: []
    };
  
    return { asset_reserve: params }
  }

  assetReserve = async (...args) => {
    return this.sendOperation(
      await this.assetReserveOperation(...args)
    )
  }
}

Event.init(BitShares)

export default BitShares