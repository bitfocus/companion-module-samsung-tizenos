import { InstanceBase, runEntrypoint, InstanceStatus, SomeCompanionConfigField } from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateVariableDefinitions } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { UpdatePresets } from './presets.js'

import got from 'got' //http library
import https from 'https' //https library

export class ModuleInstance extends InstanceBase<ModuleConfig> {
	config!: ModuleConfig // Setup in init()

	private _token?: string
	private _refreshTimer?: NodeJS.Timeout

	public macAddress?: string

	public state: {
		device?: any
		info?: any
		display?: any
	} = {}

	public settings: {
		items?: any
		values?: any
	} = {}

	constructor(internal: unknown) {
		super(internal)
	}

	private pollTimer?: NodeJS.Timeout

	private _updateVariableValues(): void {
		const device = this.state.device
		const info = this.state.info
		const display = this.state.display

		if (!info || !display) return

		this.setVariableValues({
			// ===== Device / Power =====
			power: device.power ?? '-',
			device_name: device.name ?? '-',
			model: device.model ?? '-',
			ip: device.ipaddr ?? '-',
			mac: device.mac ?? '-',
			firmware: info.device_conf?.general?.firmware_version ?? '-',
			panel_status: display.display_conf?.basic?.panel_status ?? '-',

			// ===== Source / Audio =====
			source: device.source ?? '-',
			volume: display.display_conf?.basic?.volume ?? '-',
			mute: display.display_conf?.basic?.mute ?? '-',
			sound_mode: display.display_conf?.sound?.mode ?? '-',

			// ===== Picture =====
			brightness: display.picture_video?.brightness ?? '-',
			contrast: display.picture_video?.contrast ?? '-',
			sharpness: display.picture_video?.sharpness ?? '-',
			color: display.picture_video?.color ?? '-',
			tint: display.picture_video?.tint ?? '-',
			color_tone: display.picture_video?.color_tone ?? '-',
			color_temperature: display.picture_video?.color_temperature ?? '-',
			picture_size: display.picture_video?.size ?? '-',

			// ===== Diagnosis =====
			panel_on_time: info.display_conf?.diagnosis?.panel_on_time ?? '-',
			temperature: info.display_conf?.diagnosis?.monitor_temperature ?? '-',

			// ===== Storage / System =====
			disk_free: info.device_conf?.system_info?.disk_space_available ?? '-',
			disk_used: info.device_conf?.system_info?.disk_space_usage ?? '-',
		})
	}

	//Build base API URL from config
	private _getBaseUrl(): string {
		const scheme = this.config.use_https ? 'https' : 'http'
		const host = (this.config && this.config.host) || ''
		const port = this.config && this.config.port ? `:${this.config.port}` : ''
		if (!host) return ''
		return `${scheme}://${host}${port}`
	}

	// Return HTTPS agent for self-signed certificates
	private _getHttpsAgent(): { https: https.Agent } {
		return { https: new https.Agent({ rejectUnauthorized: false }) }
	}

	async _apiRequest(
		urlsuffix: string,
		body?: Record<string, unknown>,
		method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
	): Promise<any> {
		//URL zusammenbauen
		const base = this._getBaseUrl()
		if (!base) throw new Error('Host not configured')
		const url = `${base}${urlsuffix}`

		//Optionen zusammenbauen
		const options: any = {
			method,
			timeout: { request: 7000 },
			throwHttpErrors: false,
			agent: this._getHttpsAgent(),
			headers: {
				Authorization: this._token, // nur Token
				Accept: 'application/json',
			},
			responseType: 'json',
		}

		if (body && method !== 'GET') {
			options.json = body
		}

		//console.log('API Request to', url)
		//console.log('Options:', options)

		try {
			const res = await got(url, options)

			if (res.statusCode >= 400) {
				const err: any = new Error(`Api Request failed ${res.statusCode}`)
				err.status = res.statusCode
				err.data = res.body
				throw err
			}
			return res.body
		} catch (err: any) {
			this.log('error', `Error: ${err.message || err}`)
			throw err
		}
	}
	//Feedbacks and Variables
	async fetchDeviceState(): Promise<void> {
		const res_device = await this._apiRequest(`/api/v1/devices`, undefined, 'GET')
		this.state.device = res_device.devices?.find(
			(d: any) => d.mac && d.mac.toLowerCase() === this.macAddress?.toLowerCase(),
		)
		//console.log('Using Device:', this.state.device)

		const res_info = await this._apiRequest(`/api/v1/devices/settings/info?mac=${this.macAddress}`, undefined, 'GET')
		this.state.info = res_info
		//console.log('Display Info:', res_info)

		const res_display = await this._apiRequest(
			`/api/v1/devices/settings/display?mac=${this.macAddress}`,
			undefined,
			'GET',
		)
		this.state.display = res_display
		//console.log('Display Status:', res_display)

		this._updateVariableValues()
		this.checkFeedbacks()
	}

	async fetchDeviceSettings(): Promise<void> {
		const res_settings = await this._apiRequest(
			`/api/v1/devices/settings/config?mac=${this.macAddress}`,
			undefined,
			'GET',
		)
		this.settings.items = res_settings.items
		this.settings.values = res_settings.values
		this.updateActions()
	}

	// Polling starten ?? - ist das best practice?

	startPolling(): void {
		if (this.pollTimer) return

		this.pollTimer = setInterval(() => {
			void this.fetchDeviceState().catch((err) => {
				//this.log('warn', 'Polling failed')
				this.updateStatus(InstanceStatus.UnknownError, 'Polling failed:' + (err.message || err))
			})
		}, 2000)
	}

	// Login
	async login(): Promise<void> {
		const id = this.config?.login_id ?? 'admin'
		const password = this.config?.password
		if (!password) throw new Error('Password not set in module config')

		try {
			const res = await this._apiRequest('/api/v1/auth/login', { id, password }, 'POST')

			const data: any = res

			if (!data?.access_token) {
				throw new Error('Login did not return access_token')
			}

			// Token speichern
			this._token = data.access_token
			const expires = 3600

			this.log('info', 'Login succeeded')
			this.log('debug', 'Token is ' + data.access_token + ', expires in ' + expires + ' seconds')
			try {
				this.updateStatus(InstanceStatus.Ok, 'Connected')
			} catch (_e) {
				// ignored
			}

			// Token-Refresh planen
			const refreshInMs = Math.max(10000, expires * 1000 - 30000)
			if (this._refreshTimer) clearTimeout(this._refreshTimer)
			this._refreshTimer = setTimeout(() => {
				this.log('debug', 'Refreshing token before expiry')
				this.login().catch((err: any) => {
					this.log('error', `Token refresh failed: ${err.message || err}`)
					try {
						this.updateStatus(InstanceStatus.AuthenticationFailure, `Authentication failure: ${err.message || err}`)
					} catch (_e) {
						// ignored
					}
				})
			}, refreshInMs)
		} catch (err: any) {
			this.log('error', `Login error: ${err.message || err}`)
			try {
				this.updateStatus(InstanceStatus.ConnectionFailure, `Connection failure: ${err.message || err}`)
			} catch (_e) {
				// ignored
			}
			throw err
		}
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = config

		this.updateStatus(InstanceStatus.Ok)

		this.updateActions() // export actions
		this.updateFeedbacks() // export feedbacks
		this.updatePresets() // export Presets
		this.updateVariableDefinitions() // export variable definitions

		if (!this.config.macadress) {
			this.updateStatus(InstanceStatus.BadConfig, 'MAC address not set')
			this.log('warn', 'MAC address missing – waiting for user configuration')
			return
		}

		this.macAddress = this.config.macadress.replace(/:/g, '-').toLowerCase()

		this.log('info', `Using MAC Address: ${this.macAddress}`)

		// Initialize Variables
		this._updateVariableValues()

		// Initial login
		await this.login().catch((err) => this.log('error', `Login failed: ${err.message || err}`))
		await this.fetchDeviceSettings()
		this.startPolling()
	}
	// When module gets deleted
	async destroy(): Promise<void> {
		this.log('debug', 'destroy')
		if (this.pollTimer) clearInterval(this.pollTimer)
		if (this._refreshTimer) clearTimeout(this._refreshTimer)
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.config = config
		await this.init(config)
	}

	// Return config fields for web config
	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updatePresets(): void {
		UpdatePresets(this)
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}
}

runEntrypoint(ModuleInstance, UpgradeScripts)
