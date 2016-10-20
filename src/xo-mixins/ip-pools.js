import concat from 'lodash/concat'
import diff from 'lodash/difference'
import findIndex from 'lodash/findIndex'
import flatten from 'lodash/flatten'
import highland from 'highland'
import includes from 'lodash/includes'
import keys from 'lodash/keys'
import mapValues from 'lodash/mapValues'
import pick from 'lodash/pick'
import remove from 'lodash/remove'
import { fromCallback } from 'promise-toolbox'

import { NoSuchObject } from '../api-errors'
import {
  forEach,
  generateUnsecureToken,
  isEmpty,
  lightSet,
  mapToArray,
  streamToArray,
  throwFn
} from '../utils'

// ===================================================================

class NoSuchIpPool extends NoSuchObject {
  constructor (id) {
    super(id, 'ip pool')
  }
}

const normalize = ({
  addresses,
  id = throwFn('id is a required field'),
  name = '',
  networks,
  resourceSets
}) => ({
  addresses,
  id,
  name,
  networks,
  resourceSets
})

// ===================================================================

// Note: an address cannot be in two different pools sharing a
// network.
export default class IpPools {
  constructor (xo) {
    this._store = null
    this._xo = xo

    xo.on('start', async () => {
      this._store = await xo.getStore('ipPools')
    })
  }

  async createIpPool ({ addresses, name, networks }) {
    const id = await this._generateId()

    await this._save({
      addresses,
      id,
      name,
      networks
    })

    return id
  }

  async deleteIpPool (id) {
    const store = this._store

    if (await store.has(id)) {
      await Promise.all(mapToArray(await this._xo.getAllResourceSets(), async set => {
        await this._xo.removeLimitFromResourceSet(`ipPool:${id}`, set.id)
        return this._xo.removeIpPoolFromResourceSet(id, set.id)
      }))
      await this._removeIpAddressesFromVifs(
        mapValues((await this.getIpPool(id)).addresses, 'vifs')
      )

      return store.del(id)
    }

    throw new NoSuchIpPool(id)
  }

  async getAllIpPools (userId = undefined) {
    let filter
    if (userId != null) {
      const user = await this._xo.getUser(userId)
      if (user.permission !== 'admin') {
        const resourceSets = await this._xo.getAllResourceSets(userId)
        const ipPools = lightSet(flatten(mapToArray(resourceSets, 'ipPools')))
        filter = ({ id }) => ipPools.has(id)
      }
    }

    return streamToArray(this._store.createValueStream(), {
      filter,
      mapper: normalize
    })
  }

  getIpPool (id) {
    return this._store.get(id).then(normalize, error => {
      throw error.notFound ? new NoSuchIpPool(id) : error
    })
  }

  allocIpAddresses (vifId, addAddresses, removeAddresses) {
    const updatedIpPools = {}
    const limits = {}

    const xoVif = this._xo.getObject(vifId)
    const xapi = this._xo.getXapi(xoVif)
    const vif = xapi.getObject(xoVif._xapiId)

    const allocAndSave = (() => {
      const resourseSetId = xapi.xo.getData(vif.VM, 'resourceSet')

      return () => {
        const saveIpPools = () => Promise.all(mapToArray(updatedIpPools, ipPool => this._save(ipPool)))
        return resourseSetId
          ? this._xo.allocateLimitsInResourceSet(limits, resourseSetId).then(
              saveIpPools
            )
          : saveIpPools()
      }
    })()

    return fromCallback(cb => {
      const network = vif.$network
      const networkId = network.$id

      const isVif = id => id === vifId

      highland(this._store.createValueStream()).each(ipPool => {
        const { addresses, networks } = updatedIpPools[ipPool.id] || ipPool
        if (!(addresses && networks && includes(networks, networkId))) {
          return false
        }

        let allocations = 0
        let changed = false
        forEach(removeAddresses, address => {
          let vifs, i
          if (
            (vifs = addresses[address]) &&
            (vifs = vifs.vifs) &&
            (i = findIndex(vifs, isVif)) !== -1
          ) {
            vifs.splice(i, 1)
            --allocations
            changed = true
          }
        })
        forEach(addAddresses, address => {
          const data = addresses[address]
          if (!data) {
            return
          }
          const vifs = data.vifs || (data.vifs = [])
          if (!includes(vifs, vifId)) {
            vifs.push(vifId)
            ++allocations
            changed = true
          }
        })

        if (changed) {
          const { id } = ipPool
          updatedIpPools[id] = ipPool
          limits[`ipPool:${id}`] = (limits[`ipPool:${id}`] || 0) + allocations
        }
      }).toCallback(cb)
    }).then(allocAndSave)
  }

  async _removeIpAddressesFromVifs (mapAddressVifs) {
    const mapVifAddresses = {}
    forEach(mapAddressVifs, (vifs, address) => {
      forEach(vifs, vifId => {
        if (mapVifAddresses[vifId]) {
          mapVifAddresses[vifId].push(address)
        } else {
          mapVifAddresses[vifId] = [ address ]
        }
      })
    })

    const { getXapi } = this._xo
    return Promise.all(mapToArray(mapVifAddresses, (addresses, vifId) => {
      const vif = this._xo.getObject(vifId)
      const { allowedIpv4Addresses, allowedIpv6Addresses } = vif
      remove(allowedIpv4Addresses, address => includes(addresses, address))
      remove(allowedIpv6Addresses, address => includes(addresses, address))
      this.allocIpAddresses(vifId, undefined, concat(allowedIpv4Addresses, allowedIpv6Addresses))

      return getXapi(vif).editVif(vif._xapiId, {
        ipv4Allowed: allowedIpv4Addresses,
        ipv6Allowed: allowedIpv6Addresses
      })
    }))
  }

  async updateIpPool (id, {
    addresses,
    name,
    networks,
    resourceSets
  }) {
    const ipPool = await this.getIpPool(id)
    const previousAddresses = { ...ipPool.addresses }

    name != null && (ipPool.name = name)
    if (addresses) {
      const addresses_ = ipPool.addresses || {}
      forEach(addresses, (props, address) => {
        if (props === null) {
          delete addresses_[address]
        } else {
          addresses_[address] = props
        }
      })

      // Remove the addresses that are no longer in the IP pool from the concerned VIFs
      const deletedAddresses = diff(keys(previousAddresses), keys(addresses_))
      await this._removeIpAddressesFromVifs(pick(previousAddresses, deletedAddresses))

      if (isEmpty(addresses_)) {
        delete ipPool.addresses
      } else {
        ipPool.addresses = addresses_
      }
    }

    // TODO: Implement patching like for addresses.
    if (networks) {
      ipPool.networks = networks
    }

    // TODO: Implement patching like for addresses.
    if (resourceSets) {
      ipPool.resourceSets = resourceSets
    }

    await this._save(ipPool)
  }

  async _generateId () {
    let id
    do {
      id = generateUnsecureToken(8)
    } while (await this._store.has(id))
    return id
  }

  _save (ipPool) {
    ipPool = normalize(ipPool)
    return this._store.put(ipPool.id, ipPool)
  }
}