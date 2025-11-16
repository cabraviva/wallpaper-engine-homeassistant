import mqtt from 'mqtt'
import { WallpaperEngineApi } from 'wallpaper-engine-api'
import os from 'os'
import process from 'process'

type MQTT = mqtt.MqttClient

const MQTT_BROKER = 'mqtt://192.168.178.200'
const MQTT_USERNAME = undefined // falls benötigt: 'user'
const MQTT_PASSWORD = undefined // falls benötigt: 'pass'

// wie oft (ms) Wallpapers/Profiles aktualisieren
const REFRESH_INTERVAL = 60_000

// Hilfsfunktionen
function getLocalIPv4(preferPrefix = '192.168.178'): string {
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    const addrs = ifaces[name] || []
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) {
        if (a.address.startsWith(preferPrefix)) return a.address
      }
    }
  }
  // fallback: erste nicht-interne IPv4
  for (const name of Object.keys(ifaces)) {
    const addrs = ifaces[name] || []
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return '127.0.0.1'
}

function makeTopic(...parts: string[]) {
  return parts.join('/')
}

function publishJson(client: MQTT, topic: string, payload: any, opts: mqtt.IClientPublishOptions = {}) {
  client.publish(topic, JSON.stringify(payload), opts)
}

// MQTT Home Assistant Discovery helpers
function haDiscoveryTopic(domain: string, nodeId: string, objectId: string) {
  return `homeassistant/${domain}/${nodeId}/${objectId}/config`
}

function haDevice(ip: string) {
  return {
    identifiers: [`wallpaper-engine-${ip}`],
    manufacturer: 'Wallpaper Engine',
    model: 'Wallpaper Engine (local)',
    name: `Wallpaper Engine (${ip})`,
    via_device: null
  }
}

// MAIN
async function main() {
  const localIp = getLocalIPv4()
  const deviceName = `Wallpaper Engine (${localIp})`
  const nodeId = `wallpaper_engine_${localIp.replace(/\./g, '_')}`

  const we = new WallpaperEngineApi(undefined, undefined, false)
  const client = mqtt.connect(MQTT_BROKER, {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    will: {
      topic: `homeassistant/status/${nodeId}`,
      payload: 'offline',
      retain: true,
      qos: 0
    }
  })

  let wallpapers: { id: string; title: string }[] = []
  let profiles: string[] = []
  let currentWallpaper: { id: string; title: string; properties?: any } | null = null

  // state-tracking for switches since API doesn't provide queries for state
  let state = {
    showIcons: true,
    muted: false,
    paused: false
  }

  client.on('connect', async () => {
    client.publish(`homeassistant/status/${nodeId}`, 'online', { retain: true })
    console.log('MQTT connected')
    await initialSyncAndDiscovery(client, we, nodeId, deviceName, localIp)
    subscribeCommandTopics(client, nodeId)
    // first refresh
    await refreshWallpapersProfilesAndCurrent(client, we, nodeId)
    // periodic refresh
    setInterval(() => refreshWallpapersProfilesAndCurrent(client, we, nodeId).catch(console.error), REFRESH_INTERVAL)
  })

  client.on('error', err => {
    console.error('MQTT error', err)
  })

  client.on('message', async (topic, payload) => {
    try {
      const msg = payload.toString()
      // commands are under: we/<nodeId>/...
      const parts = topic.split('/')
      // handle commands
      if (topic === makeTopic('we', nodeId, 'show_icons', 'set')) {
        if (msg === 'ON' || msg === '1' || msg.toLowerCase() === 'true') {
          await we.desktop().showIcons()
          state.showIcons = true
        } else {
          await we.desktop().hideIcons()
          state.showIcons = false
        }
        client.publish(makeTopic('we', nodeId, 'show_icons', 'state'), state.showIcons ? 'ON' : 'OFF', { retain: true })
      } else if (topic === makeTopic('we', nodeId, 'muted', 'set')) {
        if (msg === 'ON' || msg === '1' || msg.toLowerCase() === 'true') {
          await we.controls().mute()
          state.muted = true
        } else {
          await we.controls().unmute()
          state.muted = false
        }
        client.publish(makeTopic('we', nodeId, 'muted', 'state'), state.muted ? 'ON' : 'OFF', { retain: true })
      } else if (topic === makeTopic('we', nodeId, 'paused', 'set')) {
        // pause toggles in API; we'll call pause() and flip state
        await we.controls().pause()
        state.paused = !state.paused
        client.publish(makeTopic('we', nodeId, 'paused', 'state'), state.paused ? 'ON' : 'OFF', { retain: true })
      } else if (topic === makeTopic('we', nodeId, 'button_play', 'set')) {
        // payload ignored, treat as push button
        await we.controls().play()
        client.publish(makeTopic('we', nodeId, 'button_play', 'state'), 'pressed', { retain: false })
      } else if (topic === makeTopic('we', nodeId, 'button_stop', 'set')) {
        await we.controls().stop()
        client.publish(makeTopic('we', nodeId, 'button_stop', 'state'), 'pressed', { retain: false })
      } else if (topic === makeTopic('we', nodeId, 'select_wallpaper', 'set')) {
        // expect wallpaper id or path
        const selected = msg
        await we.wallpaper().load(selected)
        // update current
        await publishCurrentWallpaper(client, we, nodeId)
      } else if (topic === makeTopic('we', nodeId, 'select_profile', 'set')) {
        const profile = msg
        await we.profile().load(profile)
      } else if (topic === makeTopic('we', nodeId, 'properties', 'set')) {
        // expect JSON string with properties to apply
        let props = {}
        try {
          props = JSON.parse(msg)
          await we.wallpaper().applyProperties(props)
          // re-publish current wallpaper (properties changed)
          await publishCurrentWallpaper(client, we, nodeId)
        } catch (e) {
          console.error('Failed to apply properties, payload must be JSON', e)
        }
      } else if (topic === makeTopic('we', nodeId, 'refresh', 'set')) {
        // manual refresh trigger
        await refreshWallpapersProfilesAndCurrent(client, we, nodeId)
      }
    } catch (e) {
      console.error('Error handling MQTT message', e)
    }
  })

  async function initialSyncAndDiscovery(client: MQTT, weApi: WallpaperEngineApi, nodeId: string, deviceName: string, ip: string) {
    // publish discovery for entities (switches, buttons, sensor, selects, properties)
    const device = haDevice(ip)
    // 1) switch: Show icons
    publishJson(client,
      haDiscoveryTopic('switch', nodeId, 'show_icons'),
      {
        name: `${deviceName} Show icons`,
        unique_id: `${nodeId}_show_icons`,
        command_topic: makeTopic('we', nodeId, 'show_icons', 'set'),
        state_topic: makeTopic('we', nodeId, 'show_icons', 'state'),
        payload_on: 'ON',
        payload_off: 'OFF',
        device: device,
        retain: true
      },
      { retain: true }
    )

    // 2) switch: Muted
    publishJson(client,
      haDiscoveryTopic('switch', nodeId, 'muted'),
      {
        name: `${deviceName} Muted`,
        unique_id: `${nodeId}_muted`,
        command_topic: makeTopic('we', nodeId, 'muted', 'set'),
        state_topic: makeTopic('we', nodeId, 'muted', 'state'),
        payload_on: 'ON',
        payload_off: 'OFF',
        device: device,
        retain: true
      },
      { retain: true }
    )

    // 3) switch: Paused (toggle)
    publishJson(client,
      haDiscoveryTopic('switch', nodeId, 'paused'),
      {
        name: `${deviceName} Paused`,
        unique_id: `${nodeId}_paused`,
        command_topic: makeTopic('we', nodeId, 'paused', 'set'),
        state_topic: makeTopic('we', nodeId, 'paused', 'state'),
        payload_on: 'ON',
        payload_off: 'OFF',
        device: device,
        retain: true
      },
      { retain: true }
    )

    // 4) button: Play
    publishJson(client,
      haDiscoveryTopic('button', nodeId, 'button_play'),
      {
        name: `${deviceName} Play`,
        unique_id: `${nodeId}_play`,
        command_topic: makeTopic('we', nodeId, 'button_play', 'set'),
        device: device
      },
      { retain: true }
    )

    // 5) button: Stop
    publishJson(client,
      haDiscoveryTopic('button', nodeId, 'button_stop'),
      {
        name: `${deviceName} Stop`,
        unique_id: `${nodeId}_stop`,
        command_topic: makeTopic('we', nodeId, 'button_stop', 'set'),
        device: device
      },
      { retain: true }
    )

    // 6) sensor (readonly) Current Wallpaper
    publishJson(client,
      haDiscoveryTopic('sensor', nodeId, 'current_wallpaper'),
      {
        name: `${deviceName} Current Wallpaper`,
        unique_id: `${nodeId}_current_wallpaper`,
        state_topic: makeTopic('we', nodeId, 'current_wallpaper', 'state'),
        json_attributes_topic: makeTopic('we', nodeId, 'current_wallpaper', 'attributes'),
        device: device,
        value_template: '{{ value_json.title }}'
      },
      { retain: true }
    )

    // 7) select: Wallpaper (options populated later)
    publishJson(client,
      haDiscoveryTopic('select', nodeId, 'select_wallpaper'),
      {
        name: `${deviceName} Wallpaper`,
        unique_id: `${nodeId}_select_wallpaper`,
        command_topic: makeTopic('we', nodeId, 'select_wallpaper', 'set'),
        state_topic: makeTopic('we', nodeId, 'select_wallpaper', 'state'),
        options: [], // will be updated after we.listWallpapers
        device: device
      },
      { retain: true }
    )

    // 8) select: Profile
    publishJson(client,
      haDiscoveryTopic('select', nodeId, 'select_profile'),
      {
        name: `${deviceName} Profile`,
        unique_id: `${nodeId}_select_profile`,
        command_topic: makeTopic('we', nodeId, 'select_profile', 'set'),
        state_topic: makeTopic('we', nodeId, 'select_profile', 'state'),
        options: [],
        device: device
      },
      { retain: true }
    )

    // 9) properties setter — we expose a command topic where user can publish JSON to change properties
    // We'll create a sensor entry for convenience (not a standard entity to send commands) — alternative is to use an MQTT topic direct
    publishJson(client,
      haDiscoveryTopic('sensor', nodeId, 'properties_instructions'),
      {
        name: `${deviceName} Wallpaper Properties (publish JSON to we/${nodeId}/properties/set)`,
        unique_id: `${nodeId}_properties_instructions`,
        state_topic: makeTopic('we', nodeId, 'properties', 'last_set'),
        device: device
      },
      { retain: true }
    )
  }

  function subscribeCommandTopics(client: MQTT, nodeId: string) {
    const commands = [
      makeTopic('we', nodeId, 'show_icons', 'set'),
      makeTopic('we', nodeId, 'show_icons', 'state'),
      makeTopic('we', nodeId, 'muted', 'set'),
      makeTopic('we', nodeId, 'paused', 'set'),
      makeTopic('we', nodeId, 'button_play', 'set'),
      makeTopic('we', nodeId, 'button_stop', 'set'),
      makeTopic('we', nodeId, 'select_wallpaper', 'set'),
      makeTopic('we', nodeId, 'select_profile', 'set'),
      makeTopic('we', nodeId, 'properties', 'set'),
      makeTopic('we', nodeId, 'refresh', 'set')
    ]
    for (const t of commands) client.subscribe(t)
  }

  async function refreshWallpapersProfilesAndCurrent(client: MQTT, weApi: WallpaperEngineApi, nodeId: string) {
    try {
      const wp = await weApi.listWallpapers()
      wallpapers = wp.map(w => ({ id: w.id || w.path, title: w.title }))
      const profs = await weApi.listProfiles()
      profiles = profs || []

      // update select options (re-publish discovery payload for select with options)
      publishJson(client,
        haDiscoveryTopic('select', nodeId, 'select_wallpaper'),
        {
          name: `Wallpaper`,
          unique_id: `${nodeId}_select_wallpaper`,
          command_topic: makeTopic('we', nodeId, 'select_wallpaper', 'set'),
          state_topic: makeTopic('we', nodeId, 'select_wallpaper', 'state'),
          options: wallpapers.map(w => w.id),
          device: haDevice(localIp)
        },
        { retain: true }
      )

      publishJson(client,
        haDiscoveryTopic('select', nodeId, 'select_profile'),
        {
          name: `Profile`,
          unique_id: `${nodeId}_select_profile`,
          command_topic: makeTopic('we', nodeId, 'select_profile', 'set'),
          state_topic: makeTopic('we', nodeId, 'select_profile', 'state'),
          options: profiles,
          device: haDevice(localIp)
        },
        { retain: true }
      )

      await publishCurrentWallpaper(client, weApi, nodeId)

      // publish available options as retained topics for convenience
      client.publish(makeTopic('we', nodeId, 'wallpapers', 'list'), JSON.stringify(wallpapers), { retain: true })
      client.publish(makeTopic('we', nodeId, 'profiles', 'list'), JSON.stringify(profiles), { retain: true })
    } catch (e) {
      console.error('Failed to refresh wallpapers/profiles', e)
    }
  }

  async function publishCurrentWallpaper(client: MQTT, weApi: WallpaperEngineApi, nodeId: string) {
    try {
      const cw = await weApi.wallpaper().current()
      currentWallpaper = { id: cw.id, title: cw.title, properties: cw.properties }
      client.publish(makeTopic('we', nodeId, 'current_wallpaper', 'state'), JSON.stringify({ id: cw.id, title: cw.title }), { retain: true })
      client.publish(makeTopic('we', nodeId, 'current_wallpaper', 'attributes'), JSON.stringify({
        title: cw.title,
        id: cw.id,
        description: cw.description,
        preview: cw.preview,
        tags: cw.tags,
        path: cw.path,
        properties: cw.properties
      }), { retain: true })
      // publish select state
      client.publish(makeTopic('we', nodeId, 'select_wallpaper', 'state'), cw.id, { retain: true })
      // profile state unknown — leave as-is
      // publish last properties applied
      client.publish(makeTopic('we', nodeId, 'properties', 'last_set'), JSON.stringify(cw.properties || {}), { retain: true })
    } catch (e) {
      console.error('Failed to publish current wallpaper', e)
    }
  }

  // Handle graceful exit
  process.on('SIGINT', () => {
    console.log('Exiting, setting offline')
    client.publish(`homeassistant/status/${nodeId}`, 'offline', { retain: true }, () => {
      client.end(true, () => process.exit(0))
    })
  })
}

main().catch(err => {
  console.error('Fatal error', err)
  process.exit(1)
})