import { injectable, singleton } from 'tsyringe'
import { ChannelTypes, wikiActivities } from './types/activityResult.js'
import NodeCache from 'node-cache'
import { gql, request } from 'graphql-request'
import { EmbedBuilder, WebhookClient } from 'discord.js'
import { client } from '../main.js'
import axios from 'axios'

interface ApiResponse {
  activities: wikiActivities[]
}

const myCache = new NodeCache({ stdTTL: 100, checkperiod: 120 })

const retryTime = 15000
const notifyCount = 20
@singleton()
export default class WikiUpdates {
  CHANNEL_IDS: any
  DEV_API_URL: string
  PROD_API_URL: string
  DEV_CHANNEL_ID: string
  PROD_CHANNEL_ID: string
  REVALIDATE_SECRET: string
  PREDIQT_API_URL: string
  DEV_WIKI_WEBHOOK: string
  PROD_ALARMS_WEBHOOK: string

  private apiHealthStatus = new Map<
    ChannelTypes | 'PREDIQT',
    { isHealthy: boolean; lastCheck: number; alertSent: boolean }
  >()

  constructor() {
    this.DEV_API_URL = process.env.DEV_API_URL
    this.PROD_API_URL = process.env.PROD_API_URL
    this.PREDIQT_API_URL = process.env.PREDIQT_API_URL
    this.CHANNEL_IDS = JSON.parse(process.env.CHANNELS)
    this.DEV_CHANNEL_ID = this.CHANNEL_IDS.DEV.WIKI
    this.PROD_CHANNEL_ID = this.CHANNEL_IDS.PROD.WIKI
    this.REVALIDATE_SECRET = process.env.REVALIDATE_SECRET
    this.DEV_WIKI_WEBHOOK = process.env.DEV_WIKI_WEBHOOK as string
    this.PROD_ALARMS_WEBHOOK = process.env.PROD_ALARMS_WEBHOOK as string
  }

  getUnixtime(time: string): number {
    return Math.floor(new Date(time).getTime() / 1000)
  }

  async setTime(value: number | undefined, channelType: ChannelTypes) {
    myCache.set(`newUnix-${channelType}`, value, 100)
  }

  async getTime(channelType: ChannelTypes): Promise<number> {
    const cachedTime: number =
      (await myCache.get(`newUnix-${channelType}`)) || 0
    return cachedTime ? cachedTime : Date.now()
  }

  private async messageApiErrorStyle(
    url: string,
    errorCode: string,
    env: ChannelTypes,
  ) {
    let description = `Error code: ${errorCode}`
    let color: number = 0xff0000
    let title = `⚠️ Request to ${env} API failed ⚠️`

    if (errorCode === 'TIMEOUT') {
      description = `🕐 API is unresponsive (timeout after 60 seconds)\n⚡ This indicates the API server is not responding within the expected timeframe.`
      color = 0xff6600
      title = `⏰ ${env} API Timeout`
    } else if (errorCode === 'HEALTH_CHECK_FAILED') {
      description = `🏥 API health check failed - service may be down\n🔍 Automated monitoring detected an issue with the API endpoint.`
      color = 0xcc0000
      title = `🚨 ${env} API Health Check Failed`
    }

    const errorEmbed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setURL(url)
      .setDescription(description)
      .addFields([
        { name: '🌐 Environment', value: env, inline: true },
        { name: '🔗 URL', value: url, inline: false },
        { name: '⏰ Time', value: new Date().toLocaleString(), inline: true },
      ])
      .setTimestamp()
      .setFooter({
        text: 'EP Bot API Monitor',
      })
    return errorEmbed
  }

  private async messagePrediqtErrorStyle(url: string, errorCode: string) {
    let description = `📊 Error code: ${errorCode}`
    let color: number = 0xff0000
    let title = `📉 PrediQT API is down 📉`

    if (errorCode === 'TIMEOUT') {
      description = `📊 PredIQt API is unresponsive (timeout after 30 seconds)\n📉 The prediction market service is not responding within the expected timeframe.`
      color = 0xff6600
      title = `📉 PredIQt API Timeout`
    } else if (errorCode === 'HEALTH_CHECK_FAILED') {
      description = `📊 PredIQt API health check failed - service may be down\n📉 Automated monitoring detected an issue with the PredIQt API endpoint.`
      color = 0xcc0000
      title = `📉 PredIQt API Health Check Failed`
    }

    const errorEmbed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setURL(url)
      .setDescription(description)
      .addFields([
        { name: '📊 Service', value: 'PredIQt', inline: true },
        { name: '🔗 URL', value: url, inline: false },
        { name: '⏰ Time', value: new Date().toLocaleString(), inline: true },
      ])
      .setTimestamp()
      .setFooter({
        text: 'EP Bot PrediQT Monitor',
      })
    return errorEmbed
  }

  async notifyPrediqtError(errorCode: string) {
    try {
      const webhookUrl = this.PROD_ALARMS_WEBHOOK

      if (!webhookUrl) {
        console.error(`❌ Webhook URL not configured for PrediQT alerts`)
        return
      }

      const webhook = new WebhookClient({ url: webhookUrl })

      console.log(`📉 Sending PrediQT error notification for ${errorCode}`)

      const alertUserId = process.env.ALERT_USER_ID
      const mentionText = alertUserId ? `<@${alertUserId}> ` : ''

      await webhook.send({
        content: mentionText,
        embeds: [
          await this.messagePrediqtErrorStyle(this.PREDIQT_API_URL, errorCode),
        ],
      })

      console.log('✅ PrediQT alert sent successfully')
      webhook.destroy()
    } catch (error) {
      console.error(`❌ Failed to send PrediQT error notification:`, error)
    }
  }

  async notifyError(
    count: number,
    channelType: ChannelTypes,
    link: string,
    errorCode: string,
  ) {
    try {
      const webhookUrl =
        channelType === ChannelTypes.DEV
          ? this.DEV_WIKI_WEBHOOK
          : this.PROD_ALARMS_WEBHOOK

      if (!webhookUrl) {
        console.error(
          `❌ Webhook URL not configured for ${channelType}`,
        )
        return
      }

      const webhook = new WebhookClient({ url: webhookUrl })

      const shouldNotify =
        errorCode === 'HEALTH_CHECK_FAILED' || count % notifyCount === 0

      if (shouldNotify) {
        console.log(
          `🚨 Sending error notification to ${channelType} channel for ${errorCode}`,
        )

        const alertUserId = process.env.ALERT_USER_ID

        const mentionText = alertUserId ? `<@${alertUserId}> ` : ''

        const messageContent = `${mentionText}`

        await webhook.send({
          content: messageContent,
          embeds: [
            await this.messageApiErrorStyle(link, errorCode, channelType),
          ],
        })

        console.log('✅ Message sent successfully')
        webhook.destroy()
      }
    } catch (error) {
      console.error(`❌ Failed to send error notification:`, error)
    }
  }

  async query(
    time: number,
    channelType: ChannelTypes,
  ): Promise<wikiActivities[]> {
    const query = gql`
      {
        activities(lang: "en") {
          id
          wikiId
          type
          datetime
          user {
            id
            profile {
              username
              avatar
              links {
                twitter
              }
            }
          }
          content {
            title
            summary
            categories {
              title
            }
            tags {
              id
            }
            images {
              id
            }
            metadata {
              id
              value
            }
          }
        }
      }
    `

    let result

    if (channelType === ChannelTypes.DEV) {
      result = await this.makeApiCall(this.DEV_API_URL, query, ChannelTypes.DEV)
    }
    if (channelType === ChannelTypes.PROD) {
      result = await this.makeApiCall(
        this.PROD_API_URL,
        query,
        ChannelTypes.PROD,
      )
    }
    result = result?.activities.filter((wiki: wikiActivities) => {
      return this.getUnixtime(wiki.datetime) > time
    })

    return result as wikiActivities[]
  }

  private async makeApiCallWithTimeout(
    link: string,
    query: string,
    timeout: number = 60000,
  ): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('API_TIMEOUT'))
      }, timeout)

      request(link, query)
        .then(response => {
          clearTimeout(timeoutId)
          resolve(response as ApiResponse)
        })
        .catch(error => {
          clearTimeout(timeoutId)
          reject(error)
        })
    })
  }

  async makeApiCall(
    link: string,
    query: string,
    channelType: ChannelTypes,
    count = 0,
  ): Promise<ApiResponse> {
    let result
    const maxRetries = 5
    const timeout = 60000

    try {
      console.log(`Making API call to ${channelType} (attempt ${count + 1})`)
      const apiCall: ApiResponse = await this.makeApiCallWithTimeout(
        link,
        query,
        timeout,
      )

      if (apiCall.activities && apiCall.activities.length > 0) {
        const newUnixTime = this.getUnixtime(
          apiCall.activities[0].datetime as string,
        )
        console.log(`${channelType} time`, newUnixTime)
        await this.setTime(newUnixTime, channelType)
      }

      result = apiCall
    } catch (e: any) {
      const errorCode =
        e.message === 'API_TIMEOUT' ? 'TIMEOUT' : e.code || 'UNKNOWN_ERROR'

      console.error(
        `Error ${errorCode}: API Request to ${link} failed. Attempt ${count + 1}/${maxRetries}`,
      )

      if (count >= maxRetries - 1) {
        await this.notifyError(count + 1, channelType, link, errorCode)
        throw new Error(
          `API ${channelType} failed after ${maxRetries} attempts: ${errorCode}`,
        )
      }

      const waitTime =
        channelType === ChannelTypes.DEV ? retryTime * 100 : retryTime
      console.log(`Retrying in ${waitTime / 1000} seconds...`)
      await new Promise(r => setTimeout(r, waitTime))

      return await this.makeApiCall(link, query, channelType, count + 1)
    }

    return result as ApiResponse
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  async checkApiHealth(channelType: ChannelTypes): Promise<boolean> {
    const link =
      channelType === ChannelTypes.DEV ? this.DEV_API_URL : this.PROD_API_URL
    const simpleQuery = gql`
      {
        activities(lang: "en", limit: 1) {
          id
          datetime
        }
      }
    `

    const maxRetries = 3
    const retryDelay = 10000 // 10 seconds

    let lastError: any

    // Try up to 3 times with 10 second delays between attempts
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.makeApiCallWithTimeout(link, simpleQuery, 30000)

        // Success - update health status and return
        this.apiHealthStatus.set(channelType, {
          isHealthy: true,
          lastCheck: Date.now(),
          alertSent: false,
        })

        if (attempt > 1) {
          console.log(`✅ API ${channelType} health check succeeded on attempt ${attempt}/${maxRetries}`)
        }

        return true
      } catch (error) {
        lastError = error
        console.error(`❌ API Health Check Failed for ${channelType} (attempt ${attempt}/${maxRetries}):`, error)

        // If not the last attempt, wait before retrying
        if (attempt < maxRetries) {
          console.log(`⏳ Retrying API health check for ${channelType} in 10 seconds...`)
          await this.sleep(retryDelay)
        }
      }
    }

    // All attempts failed - preserve alertSent state
    const currentStatus = this.apiHealthStatus.get(channelType)
    this.apiHealthStatus.set(channelType, {
      isHealthy: false,
      lastCheck: Date.now(),
      alertSent: currentStatus?.alertSent || false,
    })
    console.error(`❌ API Health Check Failed for ${channelType} after ${maxRetries} attempts`)
    return false
  }

  async checkPrediqtApiHealth(): Promise<boolean> {
    const maxRetries = 3
    const retryDelay = 10000

    let lastError: any

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await axios.get(this.PREDIQT_API_URL, { timeout: 30000 })

        this.apiHealthStatus.set('PREDIQT', {
          isHealthy: true,
          lastCheck: Date.now(),
          alertSent: false,
        })

        if (attempt > 1) {
          console.log(`✅ PrediQT API health check succeeded on attempt ${attempt}/${maxRetries}`)
        }

        return true
      } catch (error) {
        lastError = error
        console.error(`❌ PrediQT API Health Check Failed (attempt ${attempt}/${maxRetries}):`, error)

        if (attempt < maxRetries) {
          console.log(`⏳ Retrying PrediQT API health check in 10 seconds...`)
          await this.sleep(retryDelay)
        }
      }
    }

    const currentStatus = this.apiHealthStatus.get('PREDIQT')
    this.apiHealthStatus.set('PREDIQT', {
      isHealthy: false,
      lastCheck: Date.now(),
      alertSent: currentStatus?.alertSent || false,
    })
    console.error(`❌ PrediQT API Health Check Failed after ${maxRetries} attempts`)
    return false
  }

  async startApiHealthMonitoring(): Promise<void> {
    const checkInterval = 300000 // 5 minutes

    console.log('🔍 Starting API Health Monitoring - checking every 5 minutes')

    this.apiHealthStatus.set(ChannelTypes.DEV, {
      isHealthy: true,
      lastCheck: 0,
      alertSent: false,
    })
    this.apiHealthStatus.set(ChannelTypes.PROD, {
      isHealthy: true,
      lastCheck: 0,
      alertSent: false,
    })
    this.apiHealthStatus.set('PREDIQT', {
      isHealthy: true,
      lastCheck: 0,
      alertSent: false,
    })

    setInterval(async () => {
      console.log('🏥 Running API health checks...')

      // Check PrediQT API health
      {
        const previousStatus = this.apiHealthStatus.get('PREDIQT')
        const isHealthy = await this.checkPrediqtApiHealth()
        const currentStatus = this.apiHealthStatus.get('PREDIQT')

        if (!isHealthy) {
          console.warn(
            `⚠️ PrediQT API is unresponsive at ${new Date().toISOString()}`,
          )

          if (!currentStatus?.alertSent) {
            console.log(`📉 Sending initial error alert for PrediQT`)
            await this.notifyPrediqtError('HEALTH_CHECK_FAILED')

            this.apiHealthStatus.set('PREDIQT', {
              isHealthy: false,
              lastCheck: Date.now(),
              alertSent: true,
            })
          } else {
            console.log(`⏳ PrediQT API still down, continuing to monitor silently...`)
          }
        } else {
          console.log(
            `✅ PrediQT API is healthy at ${new Date().toISOString()}`,
          )

          if (previousStatus && !previousStatus.isHealthy && previousStatus.alertSent) {
            console.log(`📈 PrediQT API has recovered!`)
            const webhookUrl = this.PROD_ALARMS_WEBHOOK
            if (webhookUrl) {
              const webhook = new WebhookClient({ url: webhookUrl })
              await webhook.send(
                `📈 **RECOVERY** - PrediQT API is back online! 📊`,
              )
              webhook.destroy()
            }

            this.apiHealthStatus.set('PREDIQT', {
              isHealthy: true,
              lastCheck: Date.now(),
              alertSent: false,
            })
          }
        }
      }

      for (const channelType of [ChannelTypes.DEV, ChannelTypes.PROD]) {
        const previousStatus = this.apiHealthStatus.get(channelType)
        const isHealthy = await this.checkApiHealth(channelType)
        const currentStatus = this.apiHealthStatus.get(channelType)

        if (!isHealthy) {
          console.warn(
            `⚠️ API ${channelType} is unresponsive at ${new Date().toISOString()}`,
          )

          // Only send alert if we haven't already sent one for this failure
          if (!currentStatus?.alertSent) {
            console.log(`🚨 Sending initial error alert for ${channelType}`)
            await this.notifyError(
              1,
              channelType,
              channelType === ChannelTypes.DEV
                ? this.DEV_API_URL
                : this.PROD_API_URL,
              'HEALTH_CHECK_FAILED',
            )

            // Mark that we've sent the alert
            this.apiHealthStatus.set(channelType, {
              isHealthy: false,
              lastCheck: Date.now(),
              alertSent: true,
            })
          } else {
            console.log(`⏳ API ${channelType} still down, continuing to monitor silently...`)
          }
        } else {
          console.log(
            `✅ API ${channelType} is healthy at ${new Date().toISOString()}`,
          )

          // Send recovery message only if API was previously unhealthy AND we sent an alert
          if (previousStatus && !previousStatus.isHealthy && previousStatus.alertSent) {
            console.log(`🎉 API ${channelType} has recovered!`)
            const webhookUrl =
              channelType === ChannelTypes.DEV
                ? this.DEV_WIKI_WEBHOOK
                : this.PROD_ALARMS_WEBHOOK
            if (webhookUrl) {
              const webhook = new WebhookClient({ url: webhookUrl })
              await webhook.send(
                `✅ **RECOVERY** - ${channelType} API is back online! 🎉`,
              )
              webhook.destroy()
            }

            // Reset alertSent flag since API is healthy again
            this.apiHealthStatus.set(channelType, {
              isHealthy: true,
              lastCheck: Date.now(),
              alertSent: false,
            })
          }
        }
      }
    }, checkInterval)
  }

  async testNotifications(): Promise<void> {
    console.log('🧪 Testing Discord notifications...')

    try {
      await this.notifyError(
        1,
        ChannelTypes.DEV,
        this.DEV_API_URL,
        'TEST_NOTIFICATION',
      )
      await this.notifyError(
        1,
        ChannelTypes.PROD,
        this.PROD_API_URL,
        'TEST_NOTIFICATION',
      )
      console.log('✅ Test notifications sent successfully')
    } catch (error) {
      console.error('❌ Failed to send test notifications:', error)
    }
  }

  getApiHealthStatus(): Map<
    ChannelTypes | 'PREDIQT',
    { isHealthy: boolean; lastCheck: number; alertSent: boolean }
  > {
    return new Map(this.apiHealthStatus)
  }
}
