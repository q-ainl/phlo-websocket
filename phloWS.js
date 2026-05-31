module.exports = (...input) => {
	const { WebSocketServer } = require('ws')
	const http = require('http')
	const { spawn } = require('child_process')
	const { randomBytes } = require('crypto')

	const config = normalizeConfig(...input)
	const clients = new Map

	const normalizeHost = (value) => {
		if (!value) return null
		const raw = String(value).split(',')[0].trim().toLowerCase()
		if (!raw) return null
		const host = raw.replace(/^https?:\/\//, '').split('/')[0]
		if (host.startsWith('[')) return host.replace(/^\[|\](?::\d+)?$/g, '')
		return host.replace(/:\d+$/, '')
	}

	const requestHost = (request) => normalizeHost(request.headers['x-forwarded-host'] || request.headers.host)

	const runtimeForHost = (host) => {
		host = normalizeHost(host)
		if (!host) throw new Error('Host is required.')
		const app = config.hosts[host]
		if (!app) throw new Error(`Host is not configured: ${host}`)
		return { host, app, php: config.php }
	}

	const hostClients = (host, create = false) => {
		if (!clients.has(host) && create) clients.set(host, new Map)
		return clients.get(host)
	}

	const tokenClients = (host, token, create = false) => {
		const map = hostClients(host, create)
		if (!map) return null
		if (!map.has(token) && create) map.set(token, new Map)
		return map.get(token)
	}

	const phlo = (runtime, command, args = [], stream = null) => new Promise((resolve, reject) => {
		const phpProcess = spawn(runtime.php, [runtime.app, command, ...args])
		let buffer = ''
		if (stream){
			phpProcess.stdout.on('data', (data) => {
				buffer += data.toString()
				const lines = buffer.split('\n')
				buffer = lines.pop()
				for (const line of lines) if (line.trim()) stream(line)
			})
			phpProcess.stdout.on('end', () => {
				if (buffer.trim()) stream(buffer)
			})
		}
		phpProcess.stderr.on('data', (data) => console.error(`PHP stderr for '${command}' on ${runtime.host}:\n${data.toString()}`))
		phpProcess.on('error', (err) => reject(new Error(`Failed to start PHP script for '${command}' on ${runtime.host}: ${err.message}`)))
		phpProcess.on('close', (code) => code === 0 ? resolve() : reject(new Error(`PHP script for '${command}' on ${runtime.host} exited with code ${code}`)))
	})

	const getJSONBody = (req) => new Promise((resolve, reject) => {
		let body = ''
		let rejected = false
		req.on('data', chunk => {
			body += chunk.toString()
			if (!rejected && body.length > config.maxBody){
				rejected = true
				reject(new Error('Request body too large.'))
			}
		})
		req.on('end', () => {
			if (rejected) return
			try { resolve(body ? JSON.parse(body) : {}) }
			catch { reject(new Error('Invalid JSON body.')) }
		})
		req.on('error', err => reject(err))
	})

	const cookies = (request) => Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map(part => {
		const [key, ...valParts] = part.trim().split('=')
		return [key, decodeURIComponent(valParts.join('='))]
	}))

	const parseTarget = (target) => {
		target = String(target || 'all')
		if (target === 'all') return { mode: 'all' }
		if (target.startsWith('token:not:')) return { mode: 'not', value: target.slice(10) }
		if (target.startsWith('token:')) return { mode: 'token', value: target.slice(6) }
		throw new Error(`Invalid target: ${target}`)
	}

	const sendToHost = (host, target, dataString) => {
		const map = hostClients(host)
		if (!map) return 0
		let sent = 0
		const parsed = parseTarget(target)
		const send = (token, clientWs) => {
			if (parsed.mode === 'not' && token === parsed.value) return
			if (clientWs.readyState === 1){
				clientWs.send(dataString)
				sent++
			}
		}
		if (parsed.mode === 'all' || parsed.mode === 'not'){
			for (const [token, sockets] of map.entries()) for (const [, clientWs] of sockets.entries()) send(token, clientWs)
			return sent
		}
		if (parsed.mode === 'token'){
			const sockets = tokenClients(host, parsed.value)
			if (!sockets) return sent
			for (const [, clientWs] of sockets.entries()) send(parsed.value, clientWs)
			return sent
		}
		return sent
	}

	const wss = new WebSocketServer({ noServer: true })
	wss.on('connection', (ws, request, runtime, token, socket) => {
		console.log(`connected: ${runtime.host} ${token} ${socket}`)
		tokenClients(runtime.host, token, true).set(socket, ws)
		ws.host = runtime.host
		ws.token = token
		ws.socket = socket
		phlo(runtime, 'websocket::connect', [runtime.host, token, socket]).catch(err => console.error('Phlo could not handle connect:', err.message))
		ws.on('message', (message) => {
			const currentRuntime = runtimeForHost(ws.host)
			console.log(`message: ${ws.host} ${token} ${socket}`)
			phlo(currentRuntime, 'websocket::receive', [ws.host, ws.token, ws.socket, message.toString()], line => {
				if (ws.readyState === 1) ws.send(line)
			}).catch(err => console.error('Phlo could not handle receive:', err.message))
		})
		ws.on('close', () => {
			console.log(`disconnected: ${ws.host} ${token} ${socket}`)
			const sockets = tokenClients(ws.host, ws.token)
			if (sockets){
				sockets.delete(ws.socket)
				if (!sockets.size) hostClients(ws.host)?.delete(ws.token)
			}
			if (hostClients(ws.host)?.size === 0) clients.delete(ws.host)
			phlo(runtimeForHost(ws.host), 'websocket::close', [ws.host, ws.token, ws.socket]).catch(err => console.error('Phlo could not handle close:', err.message))
		})
		ws.on('error', (error) => console.error(`Client error for ${runtime.host} ${token} ${socket}:`, error))
	})

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
		if (url.pathname === '/health' && req.method === 'GET'){
			const hosts = {}
			for (const [host, tokens] of clients.entries()){
				let sockets = 0
				for (const socketMap of tokens.values()) sockets += socketMap.size
				hosts[host] = { tokens: tokens.size, sockets }
			}
			res.writeHead(200, {'Content-Type': 'application/json'})
			res.end(JSON.stringify({ status: 'ok', hosts, configured: Object.keys(config.hosts) }))
			return
		}
		if (url.pathname === '/message' && req.method === 'POST'){
			try {
				const body = await getJSONBody(req)
				const runtime = runtimeForHost(body.host || req.headers['x-phlo-host'])
				const target = body.target || 'all'
				const dataString = JSON.stringify(body.data || {})
				const sent = sendToHost(runtime.host, target, dataString)
				console.log(`cast: ${runtime.host} ${target} ${sent}`)
				res.writeHead(200, {'Content-Type': 'application/json'})
				res.end(JSON.stringify({status: 'ok', host: runtime.host, sent}))
			}
			catch (error){
				res.writeHead(400, {'Content-Type': 'application/json'})
				res.end(JSON.stringify({status: 'error', message: error.message}))
			}
			return
		}
		res.writeHead(404).end()
	})

	server.on('upgrade', async (request, socketStream, head) => {
		try {
			const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
			if (url.pathname !== '/websocket') throw new Error('Invalid WebSocket path.')
			const runtime = runtimeForHost(requestHost(request))
			const token = cookies(request)['token']
			if (!token) throw new Error('Authentication cookie not found.')
			const socket = randomBytes(8).toString('hex')
			await phlo(runtime, 'websocket::auth', [runtime.host, token, socket])
			wss.handleUpgrade(request, socketStream, head, (ws) => wss.emit('connection', ws, request, runtime, token, socket))
		}
		catch (error) {
			console.log(`Unauthorized: ${error.message}`)
			socketStream.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
			socketStream.destroy()
		}
	})

	server.listen(config.port, config.listen, () => console.log(`PhloWS listening on ${config.listen}:${config.port}`))
}

function normalizeConfig(port, php, hostMap, listen = '127.0.0.1', maxBody = 1024 * 1024) {
	if (!port) throw new Error('Missing port.')
	if (!php) throw new Error('Missing php binary.')
	if (!hostMap || typeof hostMap !== 'object') throw new Error('Missing hosts config.')
	const hosts = {}
	for (const [host, app] of Object.entries(hostMap)){
		const key = String(host).trim().toLowerCase()
		const file = String(app).trim()
		if (!key || !file) continue
		if (!file.endsWith('/app.php')) throw new Error(`Host ${key} must point to app.php.`)
		if (!/^\/[a-zA-Z0-9_./-]+$/.test(file)) throw new Error(`Invalid app path for host ${key}.`)
		hosts[key] = file
	}
	return {
		port,
		php,
		hosts,
		listen,
		maxBody,
	}
}
