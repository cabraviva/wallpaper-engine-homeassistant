import mqtt, { MqttClient, IClientPublishOptions } from 'mqtt'
import { WallpaperEngineApi } from 'wallpaper-engine-api'
import os from 'os'
import process from 'process'

const MQTT_BROKER = 'mqtt://192.168.178.200'
const MQTT_USERNAME: string | undefined = undefined
const MQTT_PASSWORD: string | undefined = undefined
const REFRESH_INTERVAL = 60_000


async function failloop() {
  
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
  for (const name of Object.keys(ifaces)) {
    const addrs = ifaces[name] || []
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return '127.0.0.1'
}

function makeTopic(...parts: string[]): string {
  return parts.join('/')
}

function publishJson(client: MqttClient, topic: string, payload: any, opts: IClientPublishOptions = {}) {
  client.publish(topic, JSON.stringify(payload), opts)
  console.log(`Published to ${topic}: ${JSON.stringify(payload)}`)
}

function haDiscoveryTopic(domain: string, nodeId: string, objectId: string): string {
  return `homeassistant/${domain}/${nodeId}/${objectId}/config`
}

function haDevice(ip: string) {
  return {
    identifiers: [`wallpaper-engine-${ip}`],
    manufacturer: 'Wallpaper Engine',
    model: 'Wallpaper Engine (local)',
    name: `Wallpaper Engine (${ip})`
  }
}

interface WallpaperEntry { id: string; title: string }
interface State { showIcons: boolean; muted: boolean; paused: boolean }

async function main() {
  const localIp = getLocalIPv4()
  const deviceName = `Wallpaper Engine (${localIp})`
  const nodeId = `wallpaper_engine_${localIp.replace(/\./g, '_')}`

  const we = new WallpaperEngineApi(undefined, undefined, true)
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

  let wallpapers: WallpaperEntry[] = []
  let profiles: string[] = []
  let state: State = { showIcons: true, muted: false, paused: false }

  client.on('connect', async () => {
    console.log('MQTT connected')
    client.publish(`homeassistant/status/${nodeId}`, 'online', { retain: true })

     // Ensure default startup state
    try {
        await we.desktop().showIcons()
        await we.controls().unmute()
        await we.controls().play() // unpause
        state = { showIcons: true, muted: false, paused: false }
        console.log('Set initial state: show icons, unmuted, playing')
    } catch (e) {
        console.error('Failed to set initial wallpaper state', e)
    }

    await initialSyncAndDiscovery(client, we, nodeId, deviceName, localIp)
    subscribeCommandTopics(client, nodeId)
    await refreshWallpapersProfiles(client, we, nodeId)
    setInterval(() => refreshWallpapersProfiles(client, we, nodeId).catch(console.error), REFRESH_INTERVAL)
  })

  client.on('error', err => console.error('MQTT error', err))

  client.on('message', async (topic: string, payload: Buffer) => {
    try {
      const msg = payload.toString()
      console.log(`Received message on ${topic}: ${msg}`)
      switch (topic) {
        case makeTopic('we', nodeId, 'show_icons', 'set'):
          if (['ON','1'].includes(msg) || msg.toLowerCase() === 'true') {
            await we.desktop().showIcons()
            state.showIcons = true
          } else {
            await we.desktop().hideIcons()
            state.showIcons = false
          }
          client.publish(makeTopic('we', nodeId, 'show_icons', 'state'), state.showIcons?'ON':'OFF',{retain:true})
          break
        case makeTopic('we', nodeId, 'muted', 'set'):
          if (['ON','1'].includes(msg) || msg.toLowerCase() === 'true') {
            await we.controls().mute()
            state.muted = true
          } else {
            await we.controls().unmute()
            state.muted = false
          }
          client.publish(makeTopic('we', nodeId, 'muted', 'state'), state.muted?'ON':'OFF',{retain:true})
          break
        case makeTopic('we', nodeId, 'paused', 'set'):
          if (['ON','1'].includes(msg) || msg.toLowerCase() === 'true') {
            await we.controls().pause()
            state.muted = true
          } else {
            await we.controls().play()
            state.muted = false
          }
          client.publish(makeTopic('we', nodeId, 'paused', 'state'), state.paused?'ON':'OFF',{retain:true})
          break
        case makeTopic('we', nodeId, 'button_play', 'set'):
          await we.controls().play()
          client.publish(makeTopic('we', nodeId, 'button_play', 'state'),'pressed',{retain:false})
          break
        case makeTopic('we', nodeId, 'button_stop', 'set'):
          await we.controls().stop()
          client.publish(makeTopic('we', nodeId, 'button_stop', 'state'),'pressed',{retain:false})
          break
        case makeTopic('we', nodeId, 'select_wallpaper', 'set'):
          const [idWithTitle, monitorStr] = msg.split('|')
          const monitorIndex = monitorStr === 'all' ? undefined : parseInt(monitorStr)
          console.log(`Setting wallpaper ${idWithTitle} on monitor ${monitorStr}`)
          const match = wallpapers.find(w => `${w.title} (${w.id})` === idWithTitle)
          if (monitorIndex == undefined) {
            if (match) {
                for (const monitorIdOfAll of [0, 1, 2]) {
                  try {await we.wallpaper().load(match.id, monitorIdOfAll)} catch (e) {
                    console.log('crash-1a')
                    console.error(e)}
                    
                }
            } else {
                console.warn('Wallpaper not found:', idWithTitle)
            }
          } else {
            if (match) try {await we.wallpaper().load(match.id, monitorIndex)} catch (e) {console.error(e)
              console.log('crash-1b')
            }
            else console.warn('Wallpaper not found:', idWithTitle)
          }
          client.publish(makeTopic('we', nodeId, 'select_wallpaper', 'state'), msg,{retain:true})
          break
        case makeTopic('we', nodeId, 'select_profile', 'set'):
          console.log(`Loading profile ${msg}`)
          await we.profile().load(msg)
          client.publish(makeTopic('we', nodeId, 'select_profile', 'state'), msg,{retain:true})
          break
        case makeTopic('we', nodeId, 'properties', 'set'):
          try {
            const props = JSON.parse(msg)
            await we.wallpaper().applyProperties(props)
            client.publish(makeTopic('we', nodeId, 'properties', 'last_set'), JSON.stringify(props),{retain:true})
          } catch(e){console.error('Invalid JSON for properties',e)}
          break
        case makeTopic('we', nodeId, 'refresh', 'set'):
          await refreshWallpapersProfiles(client,we,nodeId)
          break
      }
    } catch(e){console.error('Error handling MQTT message', e)}
  })

  async function initialSyncAndDiscovery(client: MqttClient, weApi: WallpaperEngineApi, nodeId: string, deviceName: string, ip: string) {
    const device = haDevice(ip)
    const entities = [
      { type:'switch', id:'show_icons', name:'Show icons' },
      { type:'switch', id:'muted', name:'Muted' },
      { type:'switch', id:'paused', name:'Paused' },
      { type:'button', id:'button_play', name:'Play' },
      { type:'button', id:'button_stop', name:'Stop' },
      { type:'select', id:'select_wallpaper', name:'Wallpaper', options:[] },
      { type:'select', id:'select_profile', name:'Profile', options:[] },
      { type:'sensor', id:'properties_instructions', name:'Wallpaper Properties (publish JSON to we/${nodeId}/properties/set)'}
    ]

    for (const e of entities) {
      const topic = haDiscoveryTopic(e.type, nodeId, e.id)
      const payload: any = { name:`${deviceName} ${e.name}`, unique_id:`${nodeId}_${e.id}`, device }
      if(e.type==='switch'){ payload.command_topic = makeTopic('we', nodeId, e.id,'set'); payload.state_topic = makeTopic('we', nodeId, e.id,'state'); payload.payload_on='ON'; payload.payload_off='OFF'; payload.retain=true }
      else if(e.type==='button'){ payload.command_topic = makeTopic('we', nodeId, e.id,'set') }
      else if(e.type==='select'){ payload.command_topic = makeTopic('we', nodeId, e.id,'set'); payload.state_topic = makeTopic('we', nodeId, e.id,'state'); payload.options=[] }
      else if(e.type==='sensor'){ payload.state_topic = makeTopic('we', nodeId,'properties','last_set') }
      publishJson(client, topic, payload,{retain:true})
    }
  }

  function subscribeCommandTopics(client: MqttClient, nodeId: string){
    const commands = ['show_icons','muted','paused','button_play','button_stop','select_wallpaper','select_profile','properties','refresh']
      .map(c=>makeTopic('we', nodeId, c,'set'))
    for(const t of commands) client.subscribe(t)
  }

  async function refreshWallpapersProfiles(client: MqttClient, weApi: WallpaperEngineApi, nodeId: string){
    try{
      const wp = await weApi.listWallpapers()
      wallpapers = wp.map(w=>({id:w.id||w.path,title:w.title}))
      profiles = await weApi.listProfiles()||[]
      console.log('Refreshed wallpapers and profiles:', {wallpapers, profiles})

      const wallpaperOptions: string[] = []
      for(const w of wallpapers){
        wallpaperOptions.push(...['all',0,1,2].map(m => `${w.title} (${w.id})|${m==='all'?'all':m}`))
      }

      publishJson(client, haDiscoveryTopic('select', nodeId, 'select_wallpaper'), {
        name:'Wallpaper', unique_id:`${nodeId}_select_wallpaper`, command_topic: makeTopic('we', nodeId,'select_wallpaper','set'), state_topic: makeTopic('we', nodeId,'select_wallpaper','state'), options: wallpaperOptions, device: haDevice(getLocalIPv4())
      },{retain:true})

      publishJson(client, haDiscoveryTopic('select', nodeId, 'select_profile'), {
        name:'Profile', unique_id:`${nodeId}_select_profile`, command_topic: makeTopic('we', nodeId,'select_profile','set'), state_topic: makeTopic('we', nodeId,'select_profile','state'), options: profiles, device: haDevice(getLocalIPv4())
      },{retain:true})

      client.publish(makeTopic('we', nodeId,'wallpapers','list'), JSON.stringify(wallpapers), {retain:true})
      client.publish(makeTopic('we', nodeId,'profiles','list'), JSON.stringify(profiles), {retain:true})
    }catch(e){console.error('Failed to refresh wallpapers/profiles',e)}
  }

  process.on('SIGINT',()=>{
    console.log('Exiting, setting offline')
    client.publish(`homeassistant/status/${nodeId}`,'offline',{retain:true},()=>{client.end(true,()=>process.exit(0))})
  })
}

function rerun() {
  main().catch(err=>{console.error('Fatal error',err);rerun()})
}
rerun();
}

failloop();