const MuPort = require('muport-core')
const bip39 = require('bip39')
const localstorage = require('store')
const OrbitDB = require('orbit-db')
const Pubsub = require('orbit-db-pubsub')
const OrbitDBCacheProxy = require('orbit-db-cache-postmsg-proxy').Client
const { createProxyClient } = require('ipfs-postmsg-proxy')

const PublicStore = require('./publicStore')
const PrivateStore = require('./privateStore')
const OrbitdbKeyAdapter = require('./orbitdbKeyAdapter')
const utils = require('./utils')

const ADDRESS_SERVER_URL = 'https://beta.3box.io/address-server'
const PINNING_NODE = '/dnsaddr/ipfs.3box.io/tcp/443/wss/ipfs/QmZvxEpiVNjmNbEKyQGvFzAY1BwmGuuvdUTmcTstQPhyVC'
const PINNING_ROOM = '3box-pinning'
const IFRAME_STORE_VERSION = '0.0.2'
const IFRAME_STORE_URL = `https://iframe.3box.io/${IFRAME_STORE_VERSION}/iframe.html`

let globalIPFS, globalOrbitDB, ipfsProxy, cacheProxy

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const iframe = document.createElement('iframe')
  iframe.src = IFRAME_STORE_URL
  iframe.style = 'width:0; height:0; border:0; border:none !important'
  document.body.appendChild(iframe)
  // Create proxy clients that talks to the iframe
  const postMessage = iframe.contentWindow.postMessage.bind(iframe.contentWindow)
  ipfsProxy = createProxyClient({ postMessage })
  cacheProxy = OrbitDBCacheProxy({ postMessage })
}

class Box {
  /**
   * Please use the **openBox** method to instantiate a 3Box
   */
  constructor (muportDID, ethereumProvider, opts = {}) {
    this._muportDID = muportDID
    this._web3provider = ethereumProvider
    this._serverUrl = opts.addressServer || ADDRESS_SERVER_URL
    this._onSyncDoneCB = () => {}
    /**
     * @property {KeyValueStore} public         access the profile store of the users 3Box
     */
    this.public = null
    /**
     * @property {KeyValueStore} private        access the private store of the users 3Box
     */
    this.private = null
  }

  async _load (opts = {}) {
    const did = this._muportDID.getDid()
    const didFingerprint = utils.sha256Multihash(did)
    const rootStoreName = didFingerprint + '.root'

    const pinningNode = opts.pinningNode || PINNING_NODE
    // console.time('start ipfs')
    this._ipfs = await initIPFS(opts.ipfs, opts.iframeStore)
    // console.timeEnd('start ipfs')
    // TODO - if connection to this peer is lost we should try to reconnect
    // console.time('connect to pinning ipfs node')
    this._ipfs.swarm.connect(pinningNode, () => {
      // console.timeEnd('connect to pinning ipfs node')
    })

    const keystore = new OrbitdbKeyAdapter(this._muportDID)
    // console.time('new OrbitDB')
    const cache = (opts.iframeStore && !!cacheProxy) ? cacheProxy : null
    this._orbitdb = new OrbitDB(this._ipfs, opts.orbitPath, { keystore, cache })
    // console.timeEnd('new OrbitDB')
    globalIPFS = this._ipfs
    globalOrbitDB = this._orbitdb

    this._rootStore = await this._orbitdb.feed(rootStoreName)
    const rootStoreAddress = this._rootStore.address.toString()

    // console.time('opening pinning room, pinning node joined')
    this._pubsub = new Pubsub(this._ipfs, (await this._ipfs.id()).id)
    const onNewPeer = (topic, peer) => {
      // console.log('Peer joined the room', peer)
      // console.log(peer, pinningNode.split('/').pop())
      if (peer === pinningNode.split('/').pop()) {
        // console.timeEnd('opening pinning room, pinning node joined')
        // console.log('broadcasting odb-address')

        this._pubsub.publish(PINNING_ROOM, { type: 'PIN_DB', odbAddress: rootStoreAddress })
      }
    }

    this.public = new PublicStore(this._orbitdb, didFingerprint + '.public', this._linkProfile.bind(this))
    this.private = new PrivateStore(this._muportDID, this._orbitdb, didFingerprint + '.private')

    // console.time('load stores')
    const [pubStoreAddress, privStoreAddress] = await Promise.all([
      this.public._load(),
      this.private._load()
    ])
    // console.timeEnd('load stores')

    let syncPromises = []

    const onMessageRes = async (topic, data) => {
      if (data.type === 'HAS_ENTRIES') {
        if (data.odbAddress === privStoreAddress) {
          syncPromises.push(this.private._sync(data.numEntries))
        }
        if (data.odbAddress === pubStoreAddress) {
          syncPromises.push(this.public._sync(data.numEntries))
        }
        if (syncPromises.length === 2) {
          await Promise.all(syncPromises)
          await this._ensureDIDPublished()
          this._onSyncDoneCB()
          this._pubsub.unsubscribe(PINNING_ROOM)
        }
      }
    }

    this._pubsub.subscribe(PINNING_ROOM, onMessageRes, onNewPeer)

    await this._createRootStore(rootStoreAddress, privStoreAddress, pubStoreAddress, pinningNode)
  }

  async _createRootStore (rootStoreAddress, privOdbAddress, pubOdbAddress) {
    // console.time('add PublicStore to rootStore')
    await this._rootStore.add({ odbAddress: pubOdbAddress })
    // console.timeEnd('add PublicStore to rootStore')
    // console.time('add PrivateStore to rootStore')
    await this._rootStore.add({ odbAddress: privOdbAddress })
    // console.timeEnd('add PrivateStore to rootStore')
    // console.time('publish rootStoreAddress to address-server')
    this._publishRootStore(rootStoreAddress)
    // console.timeEnd('publish rootStoreAddress to address-server')
  }

  /**
   * Get the public profile of a given address
   *
   * @param     {String}    address                 An ethereum address
   * @param     {Object}    opts                    Optional parameters
   * @param     {String}    opts.addressServer      URL of the Address Server
   * @param     {Object}    opts.ipfs               A js-ipfs ipfs object
   * @param     {String}    opts.orbitPath          A custom path for orbitdb storage
   * @param     {Boolean}   opts.iframeStore        Use iframe for storage, allows shared store across domains. Default true when run in browser.
   * @return    {Object}                            a json object with the profile for the given address
   */
  static async getProfile (address, opts) {
    opts = Object.assign({ iframeStore: true }, opts)
    const serverUrl = opts.addressServer || ADDRESS_SERVER_URL
    const rootStoreAddress = await getRootStoreAddress(serverUrl, address.toLowerCase())
    let usingGlobalIPFS = false
    let usingGlobalOrbitDB = false
    let ipfs
    let orbitdb
    if (globalIPFS) {
      ipfs = globalIPFS
      usingGlobalIPFS = true
    } else {
      ipfs = await initIPFS(opts.ipfs, opts.iframeStore)
    }
    if (globalOrbitDB) {
      orbitdb = globalOrbitDB
      usingGlobalIPFS = true
    } else {
      const cache = (opts.iframeStore && !!cacheProxy) ? cacheProxy : null
      orbitdb = new OrbitDB(ipfs, opts.orbitPath, { cache })
    }

    const pinningNode = opts.pinningNode || PINNING_NODE
    ipfs.swarm.connect(pinningNode, () => {})

    const publicStore = new PublicStore(orbitdb)

    if (rootStoreAddress) {
      const rootStore = await orbitdb.open(rootStoreAddress)
      const readyPromise = new Promise((resolve, reject) => {
        rootStore.events.on('ready', resolve)
      })
      rootStore.load()
      await readyPromise
      if (!rootStore.iterator({ limit: -1 }).collect().length) {
        await new Promise((resolve, reject) => {
          rootStore.events.on('replicate.progress', (_x, _y, _z, num, max) => {
            if (num === max) {
              rootStore.events.on('replicated', resolve)
            }
          })
        })
      }
      const profileEntry = rootStore
        .iterator({ limit: -1 })
        .collect()
        .find(entry => {
          return entry.payload.value.odbAddress.split('.')[1] === 'public'
        })
      await publicStore._load(profileEntry.payload.value.odbAddress)
      await publicStore._sync()
      const profile = publicStore.all()
      const closeAll = async () => {
        await rootStore.close()
        await publicStore.close()
        if (!usingGlobalOrbitDB) await orbitdb.stop()
        if (!usingGlobalIPFS) await ipfs.stop()
      }
      // close but don't wait for it
      closeAll()
      return profile
    } else {
      return null
    }
  }

  /**
   * Opens the user space associated with the given address
   *
   * @param     {String}            address                 An ethereum address
   * @param     {ethereumProvider}  ethereumProvider        An ethereum provider
   * @param     {Object}            opts                    Optional parameters
   * @param     {Function}          opts.consentCallback    A function that will be called when the user has consented to opening the box
   * @param     {String}            opts.pinningNode        A string with an ipfs multi-address to a 3box pinning node
   * @param     {Object}            opts.ipfs               A js-ipfs ipfs object
   * @param     {String}            opts.orbitPath          A custom path for orbitdb storage
   * @param     {String}            opts.addressServer      URL of the Address Server
   * @param     {Boolean}           opts.iframeStore        Use iframe for storage, allows shared store across domains. Default true when run in browser.
   * @return    {Box}                                       the 3Box instance for the given address
   */
  static async openBox (address, ethereumProvider, opts) {
    opts = Object.assign({ iframeStore: true }, opts)
    const normalizedAddress = address.toLowerCase()
    // console.time('-- openBox --')
    let muportDID
    let serializedMuDID = localstorage.get('serializedMuDID_' + normalizedAddress)
    if (serializedMuDID) {
      // console.time('new Muport')
      muportDID = new MuPort(serializedMuDID)
      // console.timeEnd('new Muport')
      if (opts.consentCallback) opts.consentCallback(false)
    } else {
      const sig = await utils.openBoxConsent(normalizedAddress, ethereumProvider)
      if (opts.consentCallback) opts.consentCallback(true)
      const entropy = utils.sha256(sig.slice(2))
      const mnemonic = bip39.entropyToMnemonic(entropy)
      // console.time('muport.newIdentity')
      muportDID = await MuPort.newIdentity(null, null, {
        externalMgmtKey: normalizedAddress,
        mnemonic
      })
      // console.timeEnd('muport.newIdentity')
      localstorage.set('serializedMuDID_' + normalizedAddress, muportDID.serializeState())
    }
    // console.time('new 3box')
    const box = new Box(muportDID, ethereumProvider, opts)
    // console.timeEnd('new 3box')
    // console.time('load 3box')
    await box._load(opts)
    // console.timeEnd('load 3box')
    // console.timeEnd('-- openBox --')
    return box
  }

  /**
   * Sets the callback function that will be called once when the db is fully synced.
   *
   * @param     {Function}      syncDone        The function that will be called
   */
  onSyncDone (syncDone) {
    this._onSyncDoneCB = syncDone
  }

  async _publishRootStore (rootStoreAddress) {
    // Sign rootStoreAddress
    const addressToken = await this._muportDID.signJWT({ rootStoreAddress })
    // Store odbAddress on 3box-address-server
    try {
      await utils.httpRequest(this._serverUrl + '/odbAddress', 'POST', {
        address_token: addressToken
      })
    } catch (err) {
      throw new Error(err)
    }
    return true
  }

  async _linkProfile () {
    const address = this._muportDID.getDidDocument().managementKey
    if (!localstorage.get('linkConsent_' + address)) {
      const did = this._muportDID.getDid()
      const consent = await utils.getLinkConsent(
        address,
        did,
        this._web3provider
      )
      const linkData = {
        consent_msg: consent.msg,
        consent_signature: consent.sig,
        linked_did: did
      }
      // Send consentSignature to 3box-address-server to link profile with ethereum address
      try {
        await utils.httpRequest(this._serverUrl + '/link', 'POST', linkData)

        // Store linkConsent into localstorage
        const linkConsent = {
          address: address,
          did: did,
          consent: consent
        }
        localstorage.set('linkConsent_' + address, linkConsent)
      } catch (err) {
        console.error(err)
      }
    }
  }

  async _ensureDIDPublished () {
    if (!(await this.public.get('did'))) {
      await this.public.set('did', this._muportDID.getDid())
    }
  }

  /**
   * Closes the 3box instance without clearing the local cache.
   * Should be called after you are done using the 3Box instance,
   * but without logging the user out.
   */
  async close () {
    await this._orbitdb.stop()
    await this._pubsub.disconnect()
    // await this._ipfs.stop()
    globalOrbitDB = null
    globalIPFS = null
  }

  /**
   * Closes the 3box instance and clears local cache. If you call this,
   * users will need to sign a consent message to log in the next time
   * you call openBox.
   */
  async logout () {
    await this.close()
    const address = this._muportDID.getDidDocument().managementKey
    localstorage.remove('serializedMuDID_' + address)
    localstorage.remove('linkConsent_' + address)
  }

  /**
   * Check if the given address is logged in
   *
   * @param     {String}    address                 An ethereum address
   * @return    {Boolean}                           true if the user is logged in
   */
  static isLoggedIn (address) {
    return Boolean(localstorage.get('serializedMuDID_' + address.toLowerCase()))
  }
}

async function initIPFS (ipfs, iframeStore) {
  return new Promise((resolve, reject) => {
    if (!ipfs && !ipfsProxy) reject(new Error('No IPFS object configured and no default available for environment'))
    if (!!ipfs && iframeStore) console.log('Warning: iframeStore true, orbit db cache in iframe, but the given ipfs object is being used, and may not be running in same iframe.')
    if (ipfs) {
      resolve(ipfs)
      // TODO assume reayd object??
      // ipfs.on('ready', () => resolve(ipfs))
    } else {
      // TODO is this already from iframe? does it wait to return messages until ready?
      resolve(ipfsProxy)
    }
    // ipfs.on('error', error => {
    //   console.error(error)
    //   reject(error)
    // })
  })
}

async function getRootStoreAddress (serverUrl, identifier) {
  return new Promise(async (resolve, reject) => {
    try {
      // read orbitdb root store address from the 3box-address-server
      const res = await utils.httpRequest(
        serverUrl + '/odbAddress/' + identifier,
        'GET'
      )
      resolve(res.data.rootStoreAddress)
    } catch (err) {
      if (JSON.parse(err).message === 'root store address not found') {
        resolve(null)
      }
      reject(err)
    }
  })
}

module.exports = Box
