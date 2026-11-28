/* Mail servers set up for everybody (Administration > Mail). Talks to AdminController, which only administrators reach. */
(function () {
	'use strict'
	const root = document.getElementById('ncmail-servers')
	if (!root) return

	// the side panel and the dialog live on the page body: inside the settings area they would sit under Nextcloud's header
	const layer = document.createElement('div')
	layer.id = 'ncmail-layer'
	document.body.append(layer)
	const url = (p) => OC.generateUrl('/apps/ncmail/admin/mail-servers' + p)
	const KINDS = [['imap', 'Incoming mail', 'IMAP'], ['smtp', 'Outgoing mail', 'SMTP']]
	const SEC = { tls: 'SSL/TLS', starttls: 'STARTTLS', none: 'Not encrypted' }
	const PORTS = { imap: { tls: 993, starttls: 143, none: 143 }, smtp: { tls: 465, starttls: 587, none: 25 }, sieve: { tls: 4190, starttls: 4190, none: 4190 } }
	const me = (OC.getCurrentUser && OC.getCurrentUser().uid) || 'their-user-name'

	let view = null // { file, admin, status, updatedAt, updatedBy }
	let panel = null // { index (-1 = new), draft, checks, checking, sieveOn, sieveOpen }
	let modal = null // { step: 'ask' | 'busy' | 'found' | 'none', domain, found, status, name, username, error }
	let checkingAll = false
	let previewAddress = ''
	let previewTimer = null
	let versions = null // { app: { version, minServiceVersion }, service: { version, minAppVersion } | null, error }
	let flash = null // { text, kind }

	// ---- helpers ----
	const el = (tag, attrs, ...kids) => {
		const e = document.createElement(tag)
		for (const [k, v] of Object.entries(attrs || {})) {
			if (k === 'class') e.className = v
			else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v)
			else if (v === true) e.setAttribute(k, '')
			else if (v !== false && v != null) e.setAttribute(k, v)
		}
		for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)))
		return e
	}
	const ICON = {
		plus: '<path d="M12 5v14M5 12h14"/>',
		check: '<path d="M5 12l5 5L20 7"/>',
		alert: '<path d="M12 8v5M12 17h.01"/>',
		cross: '<path d="M6 6l12 12M18 6L6 18"/>',
		refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
		edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
		trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
		lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
	}
	/** An icon from the fixed set above (never from data). */
	const svg = (name, size = 16) => {
		const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
		for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v)
		s.innerHTML = ICON[name] || ''
		return s
	}
	const clone = (o) => JSON.parse(JSON.stringify(o))
	const ago = (iso) => {
		if (!iso) return 'Not checked yet'
		const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
		if (m < 1) return 'Checked just now'
		if (m < 60) return 'Checked ' + m + ' minute' + (m === 1 ? '' : 's') + ' ago'
		const h = Math.round(m / 60)
		if (h < 48) return 'Checked ' + h + ' hour' + (h === 1 ? '' : 's') + ' ago'
		return 'Checked ' + new Date(iso).toLocaleDateString()
	}
	const cleanDomain = (s) => (s || '').trim().toLowerCase().replace(/^@/, '')
	/** Dotted versions compared numerically; anything after a "-" is ignored. */
	const cmpVersion = (a, b) => {
		const p = (v) => String(v || '').replace(/^v/, '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0)
		const x = p(a), y = p(b)
		for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return Math.sign(d) }
		return 0
	}
	/** What to tell the administrator about the Nextcloud app's and the mail service's versions. */
	function compatibility(v) {
		if (!v) return null
		const app = v.app.version
		if (!v.service) return { tone: 'bad', title: 'The mail service cannot be reached', text: (v.error || '') + ' Check the mail service address under Connection to the mail service below.' }
		const svc = v.service.version
		const both = 'Nextcloud app ' + app + ', mail service ' + svc + '.'
		if (cmpVersion(svc, v.app.minServiceVersion) < 0) return { tone: 'bad', title: 'The mail service is too old for this Nextcloud app', text: both + ' Update the mail service to ' + app + '.' }
		if (v.service.minAppVersion && cmpVersion(app, v.service.minAppVersion) < 0) return { tone: 'bad', title: 'The Nextcloud app is too old for this mail service', text: both + ' Update the Nextcloud app to ' + svc + '.' }
		if (cmpVersion(app, svc) !== 0) {
			const older = cmpVersion(app, svc) < 0 ? 'the Nextcloud app' : 'the mail service'
			return { tone: 'warn', title: 'The Nextcloud app and the mail service have different versions', text: both + ' They work together, but update ' + older + ' to ' + (cmpVersion(app, svc) < 0 ? svc : app) + ' to keep them in step.' }
		}
		return { tone: 'ok', text: 'Nextcloud app and mail service are both version ' + app + '.' }
	}
	function versionNote() {
		const c = compatibility(versions)
		if (!c) return null
		const others = (versions && versions.service && versions.service.otherInstances) || []
		if (others.length) {
			// one service instance per database is the supported setup: more than one can undo each other's work
			const where = others.map((o) => o.host || 'another machine').join(', ')
			return el('div', { class: 'ncm-info ncm-versions bad', role: 'alert' },
				el('strong', {}, svg('alert', 16), 'More than one mail service is running on the same database'),
				el('span', { class: 'ncm-sub' }, 'Also running on: ' + where + '. Only one instance is supported: stop the others. ' + c.text))
		}
		if (c.tone === 'ok') return el('p', { class: 'ncm-sub ncm-versions' }, c.text)
		return el('div', { class: 'ncm-info ncm-versions ' + c.tone, role: c.tone === 'bad' ? 'alert' : 'status' }, el('strong', {}, svg('alert', 16), c.title), el('span', { class: 'ncm-sub' }, c.text))
	}
	const fileLocks = () => view.file.configured && !view.file.allowCustom
	const customAllowed = () => view.admin.allowCustom && !fileLocks()

	async function request(method, path, body) {
		const r = await fetch(url(path), {
			method,
			headers: { requesttoken: OC.requestToken, 'Content-Type': 'application/json', Accept: 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		const data = await r.json().catch(() => ({}))
		if (!r.ok) throw new Error(data.error || data.message || 'The mail service did not accept this (' + r.status + ').')
		return data
	}

	async function save(next, done) {
		try {
			view = await request('PUT', '', { config: next })
			flash = { text: done, kind: 'success' }
			panel = null; modal = null
			render()
			// new and changed servers are checked by the service right after saving: pick up the results
			setTimeout(() => request('GET', '').then((d) => { view = d; if (!panel && !modal) render() }).catch(() => {}), 6000)
		} catch (e) { flash = { text: e.message, kind: 'error' }; render() }
	}

	// ---- a server's state, from its last check ----
	function summary(st, s) {
		if (!st) return { tone: 'muted', text: 'Not checked yet', sub: 'Use Check all' }
		const parts = [['imap', 'Incoming'], ['smtp', 'Outgoing'], ['sieve', 'Filters']].filter(([k]) => st[k] && (k !== 'sieve' || s.sieve))
		const bad = parts.find(([k]) => !st[k].ok)
		if (bad) return { tone: 'bad', text: bad[1] + ' not answering', sub: ago(st.checkedAt) }
		const plain = parts.find(([k]) => st[k].warning === 'plain')
		if (plain) return { tone: 'bad', text: plain[1] + ' not encrypted', sub: 'Passwords travel in clear text' }
		const soon = parts.filter(([k]) => st[k].warning === 'cert-soon')
		if (soon.length) {
			const days = Math.max(0, Math.floor((new Date(st[soon[0][0]].certExpires).getTime() - Date.now()) / 86400000))
			return { tone: 'warn', text: 'Certificate expires soon', sub: 'In ' + days + ' day' + (days === 1 ? '' : 's') + ', ' + soon.map(([, n]) => n.toLowerCase()).join(' and ') }
		}
		return { tone: 'ok', text: 'Working', sub: ago(st.checkedAt) }
	}
	const pill = (tone, text) => el('span', { class: 'ncm-pill ' + tone }, tone === 'muted' ? null : svg(tone === 'ok' ? 'check' : 'alert', 12), text)
	const toneOf = (c) => (!c ? '' : !c.ok ? 'bad' : c.warning ? 'warn' : 'ok')

	// ---- overview ----
	function row(s, i, fromFile) {
		const st = summary(view.status && view.status[s.id], s)
		return el('div', { class: 'ncm-row' + (fromFile ? ' file' : ''), role: 'row' },
			el('div', { class: 'ncm-cell ncm-name', role: 'cell' },
				el('span', { class: 'ncm-title' }, s.name, fromFile ? el('span', { class: 'ncm-lock', title: 'Read-only' }, svg('lock', 14)) : null),
				fromFile
					? el('span', { class: 'ncm-sub' }, 'From mail-servers.json on the mail service. Change it there.')
					: el('span', { class: 'ncm-chips' }, s.domains.length ? s.domains.map((d) => el('span', { class: 'ncm-chip' }, '@' + d)) : el('span', { class: 'ncm-sub' }, 'Not suggested by address'))),
			el('div', { class: 'ncm-cell', role: 'cell' }, el('span', { class: 'ncm-label ncm-narrow' }, 'Incoming'), el('span', { class: 'ncm-mono' }, s.imap.host), el('span', { class: 'ncm-sub' }, s.imap.port + ' · ' + SEC[s.imap.security])),
			el('div', { class: 'ncm-cell', role: 'cell' }, el('span', { class: 'ncm-label ncm-narrow' }, 'Outgoing'), el('span', { class: 'ncm-mono' }, s.smtp.host), el('span', { class: 'ncm-sub' }, s.smtp.port + ' · ' + SEC[s.smtp.security] + (s.sieve ? ' · filters on ' + s.sieve.port : ''))),
			el('div', { class: 'ncm-cell', role: 'cell' }, pill(st.tone, st.text), el('span', { class: 'ncm-sub' }, st.sub)),
			el('div', { class: 'ncm-cell ncm-actions', role: 'cell' },
				fromFile ? null : el('button', { type: 'button', class: 'ncm-icon', 'aria-label': 'Edit ' + s.name, title: 'Edit', onclick: () => openPanel(i) }, svg('edit', 17)),
				fromFile ? null : el('button', { type: 'button', class: 'ncm-icon', 'aria-label': 'Remove ' + s.name, title: 'Remove', onclick: () => remove(i) }, svg('trash', 17))))
	}

	function remove(i) {
		const s = view.admin.servers[i]
		const go = () => save({ ...view.admin, servers: view.admin.servers.filter((_, j) => j !== i) }, 'Removed ' + s.name + '.')
		const text = 'People who already added an account on this server keep it. New accounts can no longer choose it.'
		if (OC.dialogs && OC.dialogs.confirmDestructive) {
			OC.dialogs.confirmDestructive(text, 'Remove ' + s.name + '?', { type: OC.dialogs.YES_NO_BUTTONS, confirm: 'Remove', confirmClasses: 'error', cancel: 'Cancel' }, (ok) => { if (ok) go() })
		} else if (window.confirm('Remove ' + s.name + '? ' + text)) go()
	}

	function policy() {
		const custom = customAllowed()
		const option = (value, title, text) => el('label', { class: 'ncm-choice' + (value === custom ? ' on' : '') },
			el('input', { type: 'radio', name: 'ncm-policy', checked: value === custom, disabled: fileLocks(),
				onchange: () => save({ ...view.admin, allowCustom: value }, value ? 'People can now also enter their own servers.' : 'People can now only use the servers listed here.') }),
			el('span', { class: 'ncm-choice-text' }, el('span', { class: 'ncm-choice-title' }, title), el('span', { class: 'ncm-sub' }, text)))
		return el('fieldset', { class: 'ncm-card ncm-policy' },
			el('legend', {}, 'Which servers can people use?'),
			el('div', { class: 'ncm-choices' },
				option(false, 'Only the servers listed here', 'Use this when company mail must stay on company servers.'),
				option(true, 'Listed servers, or their own', 'People whose server is not listed can enter it themselves.')),
			fileLocks() ? el('p', { class: 'ncm-sub' }, 'Locked by the configuration file on the mail service (allowCustom is false there).') : null,
			!custom && !view.file.servers.length && !view.admin.servers.length ? el('p', { class: 'ncm-warning' }, 'No servers are listed yet, so this has no effect until you add one.') : null)
	}

	function preview(all) {
		if (!previewAddress) previewAddress = 'anna@' + ((all.find((s) => s.domains.length) || { domains: ['example.com'] }).domains[0])
		const domain = cleanDomain(previewAddress.split('@')[1])
		const match = all.find((s) => s.domains.includes(domain)) || (all.length === 1 ? all[0] : null)
		const custom = customAllowed()
		const banner = match
			? el('span', { class: 'ncm-banner ok' }, svg('check', 15), match.name + ' is set up for them')
			: custom
				? el('span', { class: 'ncm-banner' }, 'They enter their mail server themselves')
				: el('span', { class: 'ncm-banner bad' }, svg('alert', 15), 'No server is listed for this address, so they cannot add it')
		// the preview follows the address while it is typed (a short pause, then the page redraws and the cursor stays put)
		const input = el('input', { type: 'text', inputmode: 'email', autocomplete: 'off', spellcheck: 'false', class: 'ncm-input', value: previewAddress, id: 'ncm-preview' })
		const update = () => {
			clearTimeout(previewTimer)
			if (input.value.trim() === previewAddress) return
			previewAddress = input.value.trim()
			const at = input.selectionStart
			render()
			const again = root.querySelector('#ncm-preview')
			if (again) { again.focus(); again.setSelectionRange(at, at) }
		}
		input.addEventListener('input', () => { clearTimeout(previewTimer); previewTimer = setTimeout(update, 350) })
		input.addEventListener('change', update)
		return el('aside', { class: 'ncm-aside', 'aria-label': 'What people see' },
			el('span', { class: 'ncm-label caps' }, 'What people see'),
			el('div', { class: 'ncm-card ncm-mock', 'aria-hidden': 'true' },
				el('strong', {}, 'Add your mail account'),
				el('span', { class: 'ncm-mock-field' }, el('span', {}, 'Email address'), el('span', { class: 'ncm-mock-input' }, previewAddress)),
				banner,
				match || !custom ? null : el('span', { class: 'ncm-mock-field' }, el('span', {}, 'Incoming mail server'), el('span', { class: 'ncm-mock-input muted' }, 'imap.…')),
				match || custom ? el('span', { class: 'ncm-mock-field' }, el('span', {}, 'Password'), el('span', { class: 'ncm-mock-input' }, '••••••••')) : null,
				el('span', { class: 'ncm-mock-button' + (match || custom ? '' : ' off') }, 'Add account')),
			el('label', { class: 'ncm-field', for: 'ncm-preview' }, el('span', { class: 'ncm-sub' }, 'Preview for the address'), input))
	}

	function render() {
		const all = view.file.servers.concat(view.admin.servers)
		const changed = view.updatedAt ? 'Last changed ' + new Date(view.updatedAt).toLocaleString() + (view.updatedBy ? ' by ' + view.updatedBy : '') + '. ' : ''
		const openAdd = () => { modal = { step: 'ask', domain: '' }; flash = null; render() }
		root.replaceChildren(...[
			el('div', { class: 'ncm-head' },
				el('div', {}, el('h2', {}, 'Mail servers'), el('p', { class: 'ncm-lead' }, 'Set up your organisation\'s servers once. People then add their mail account with only their email address and password.')),
				el('div', { class: 'ncm-head-actions' },
					all.length ? el('button', { type: 'button', class: 'ncm-btn', disabled: checkingAll, onclick: checkAllNow }, svg('refresh', 16), checkingAll ? 'Checking…' : 'Check all') : null,
					el('button', { type: 'button', class: 'ncm-btn primary', onclick: openAdd }, svg('plus', 16), 'Add mail server'))),
			versionNote(),
			flash && !panel ? el('p', { class: 'ncm-flash ' + flash.kind, role: 'status' }, flash.text) : null,
			el('div', { class: 'ncm-layout' + (all.length ? '' : ' single') },
				el('div', { class: 'ncm-main' },
					policy(),
					all.length
						? el('div', { class: 'ncm-card ncm-table', role: 'table', 'aria-label': 'Mail servers' },
							el('div', { class: 'ncm-row ncm-th', role: 'row' }, ['Server', 'Incoming', 'Outgoing', 'Status', ''].map((h) => el('span', { role: 'columnheader' }, h))),
							view.file.servers.map((s) => row(s, -1, true)),
							view.admin.servers.map((s, i) => row(s, i, false)))
						: el('div', { class: 'ncm-card ncm-empty' },
							el('strong', {}, 'No mail servers yet'),
							el('span', { class: 'ncm-sub' }, 'Add your organisation\'s server, and people only need their address and password.'),
							el('button', { type: 'button', class: 'ncm-btn primary', onclick: openAdd }, svg('plus', 16), 'Add mail server')),
					el('p', { class: 'ncm-sub' }, changed + 'People who already added an account keep it when a server is edited or removed.')),
				all.length ? preview(all) : null),
		].filter(Boolean))
		layer.replaceChildren(...[panel ? panelView() : null, modal ? modalView() : null].filter(Boolean))
		document.body.style.overflow = panel || modal ? 'hidden' : ''
	}

	async function checkAllNow() {
		checkingAll = true; render()
		try { const r = await request('POST', '/check-all', {}); view.status = r.status; flash = null }
		catch (e) { flash = { text: e.message, kind: 'error' } }
		checkingAll = false; render()
	}

	// ---- side panel: edit or add a server ----
	function openPanel(index, draft, checks) {
		const s = draft || clone(view.admin.servers[index])
		panel = { index, draft: s, checks: checks || (index >= 0 && view.status ? view.status[s.id] || null : null), checking: false, sieveOn: !!s.sieve, sieveOpen: false }
		if (!s.sieve) s.sieve = { host: s.imap.host, port: 4190, security: 'starttls' }
		modal = null; flash = null
		render()
	}

	function domainChips(d) {
		const input = el('input', { type: 'text', 'aria-label': 'Add a domain', placeholder: d.domains.length ? 'Add domain' : 'example.com', spellcheck: 'false' })
		const refocus = () => setTimeout(() => { const i = layer.querySelector('.ncm-chipbox input'); if (i) i.focus() }, 0)
		const add = (keepFocus) => {
			const v = input.value.split(/[\s,;]+/).map(cleanDomain).filter(Boolean)
			if (!v.length) return
			d.domains = [...new Set(d.domains.concat(v))]
			render(); if (keepFocus) refocus()
		}
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ',' || e.key === ' ') { e.preventDefault(); add(true) }
			else if (e.key === 'Backspace' && !input.value && d.domains.length) { d.domains.pop(); render(); refocus() }
		})
		input.addEventListener('blur', () => add(false))
		return el('div', { class: 'ncm-chipbox', role: 'group', 'aria-labelledby': 'ncm-dom' },
			d.domains.map((x, i) => el('span', { class: 'ncm-chip' }, x,
				el('button', { type: 'button', 'aria-label': 'Remove ' + x, onclick: () => { d.domains.splice(i, 1); render() } }, svg('cross', 12)))),
			input)
	}

	function securitySwitch(kind, srv, label) {
		return el('div', { class: 'ncm-seg', role: 'group', 'aria-label': label + ' security' },
			Object.entries(SEC).map(([k, v]) => el('button', {
				type: 'button', 'aria-pressed': String(srv.security === k),
				onclick: () => {
					// the port follows when it was the usual one
					if (Object.values(PORTS[kind]).includes(Number(srv.port))) srv.port = PORTS[kind][k]
					srv.security = k
					if (panel.checks) panel.checks = { ...panel.checks, [kind]: null }
					render()
				},
			}, v)))
	}

	function checkLine(kind) {
		if (panel.checking) return el('span', { class: 'ncm-status muted' }, 'Checking…')
		const c = panel.checks && panel.checks[kind]
		if (!c) return null
		const tone = toneOf(c)
		return el('span', { class: 'ncm-status ' + tone }, svg(tone === 'ok' ? 'check' : 'alert', 14), c.message)
	}

	function hostPort(kind, proto, srv) {
		const host = el('input', { type: 'text', class: 'ncm-input ncm-mono', value: srv.host, 'aria-label': proto + ' server', placeholder: kind === 'smtp' ? 'smtp.example.com' : 'imap.example.com', spellcheck: 'false' })
		host.addEventListener('input', () => {
			srv.host = host.value.trim()
			if (kind === 'imap') {
				// the usual neighbours of a new server: imap.example.com -> smtp.example.com, filters on the IMAP host
				if (panel.index === -1 && !panel.smtpTouched) {
					panel.draft.smtp.host = srv.host.replace(/^imap\./i, 'smtp.')
					const other = layer.querySelector('[aria-label="SMTP server"]'); if (other) other.value = panel.draft.smtp.host
				}
				if (!panel.sieveTouched) panel.draft.sieve.host = srv.host
			}
			if (kind === 'smtp') panel.smtpTouched = true
			if (kind === 'sieve') panel.sieveTouched = true
		})
		const port = el('input', { type: 'number', class: 'ncm-input', min: '1', max: '65535', value: String(srv.port), 'aria-label': proto + ' port' })
		port.addEventListener('input', () => { srv.port = Number(port.value) })
		return el('div', { class: 'ncm-hostport' }, host, port)
	}

	function serverCard(kind, title, proto, srv) {
		const c = panel.checks && panel.checks[kind]
		const fix = c && !c.ok && c.suggestion
			? el('span', { class: 'ncm-fix' }, 'Port ' + c.suggestion.port + ' with ' + SEC[c.suggestion.security] + ' answers.',
				el('button', { type: 'button', class: 'ncm-btn small', onclick: () => {
					srv.port = c.suggestion.port; srv.security = c.suggestion.security
					panel.checks = { ...panel.checks, [kind]: { ok: true, message: 'Answers on port ' + srv.port + '. Save to keep it.' } }
					render()
				} }, 'Use ' + c.suggestion.port))
			: null
		return el('div', { class: 'ncm-srv ' + toneOf(c) },
			el('div', { class: 'ncm-srv-head' }, el('strong', {}, title, ' ', el('span', { class: 'ncm-sub' }, proto)), checkLine(kind)),
			hostPort(kind, proto, srv),
			el('div', { class: 'ncm-srv-foot' }, securitySwitch(kind, srv, proto), fix))
	}

	function panelView() {
		const d = panel.draft
		const isNew = panel.index === -1
		const local = cleanDomain(previewAddress.split('@')[0]) || 'anna'
		const dom = d.domains[0] || 'example.com'
		const loginChoice = (value, title, example) => el('label', { class: 'ncm-choice small' + (d.username === value ? ' on' : '') },
			el('input', { type: 'radio', name: 'ncm-login', checked: d.username === value, onchange: () => { d.username = value; render() } }),
			el('span', { class: 'ncm-choice-text' }, el('span', { class: 'ncm-choice-title' }, title), el('span', { class: 'ncm-sub ncm-mono' }, example)))
		const name = el('input', { type: 'text', class: 'ncm-input', value: d.name, placeholder: 'Company mail', id: 'ncm-name' })
		name.addEventListener('input', () => { d.name = name.value })
		const sieveOn = el('input', { type: 'checkbox', checked: panel.sieveOn, onchange: () => { panel.sieveOn = !panel.sieveOn; render() } })
		const sieveCheck = panel.sieveOn && panel.checks ? panel.checks.sieve : null

		const close = () => { panel = null; flash = null; render() }
		const runCheck = async () => {
			panel.checking = true; render()
			try { panel.checks = await request('POST', '/check', { imap: d.imap, smtp: d.smtp, sieve: panel.sieveOn ? d.sieve : null }); flash = null }
			catch (e) { flash = { text: e.message, kind: 'error' } }
			if (panel) { panel.checking = false; render() }
		}
		const submit = (ev) => {
			ev.preventDefault()
			if (!d.name.trim() || !d.imap.host || !d.smtp.host) { flash = { text: 'Enter a name and both server addresses.', kind: 'error' }; render(); return }
			const entry = { ...clone(d), name: d.name.trim() }
			if (!panel.sieveOn) delete entry.sieve
			const servers = view.admin.servers.slice()
			if (isNew) servers.push(entry); else servers[panel.index] = entry
			save({ ...view.admin, servers }, (isNew ? 'Added ' : 'Saved ') + entry.name + '.')
		}
		const form = el('form', {
			class: 'ncm-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': isNew ? 'Add mail server' : 'Edit ' + d.name, onsubmit: submit,
			onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); close() } },
		},
		el('div', { class: 'ncm-panel-head' },
			el('div', {}, el('span', { class: 'ncm-sub' }, 'Mail servers'), el('h3', {}, isNew ? 'Add mail server' : 'Edit ' + (d.name || 'mail server'))),
			el('button', { type: 'button', class: 'ncm-icon', 'aria-label': 'Close', onclick: close }, svg('cross', 18))),
		el('div', { class: 'ncm-panel-body' },
			flash && flash.kind === 'error' ? el('p', { class: 'ncm-flash error', role: 'alert' }, flash.text) : null,
			el('div', { class: 'ncm-two' },
				el('label', { class: 'ncm-field', for: 'ncm-name' }, el('span', { class: 'ncm-label' }, 'Name people see'), name),
				el('div', { class: 'ncm-field' }, el('span', { class: 'ncm-label', id: 'ncm-dom' }, 'Suggested for addresses at'), domainChips(d))),
			el('fieldset', { class: 'ncm-field' },
				el('legend', { class: 'ncm-label' }, 'People sign in to the mail server with'),
				el('div', { class: 'ncm-choices three' },
					loginChoice('email', 'Email address', local + '@' + dom),
					loginChoice('local', 'Before the @', local),
					loginChoice('uid', 'Nextcloud user', me))),
			KINDS.map(([k, t, p]) => serverCard(k, t, p, d[k])),
			el('div', { class: 'ncm-srv ' + toneOf(sieveCheck) },
				el('div', { class: 'ncm-srv-head' },
					el('label', { class: 'ncm-check' }, sieveOn, el('span', { class: 'ncm-choice-text' }, el('strong', {}, 'Filters and out-of-office'),
						el('span', { class: 'ncm-sub' }, panel.sieveOn ? 'ManageSieve on ' + d.sieve.host + ':' + d.sieve.port + ', ' + SEC[d.sieve.security] : 'Off: people cannot set up filters on this server'))),
					panel.sieveOn && !panel.sieveOpen ? el('button', { type: 'button', class: 'ncm-btn small', onclick: () => { panel.sieveOpen = true; render() } }, 'Change') : null),
				panel.sieveOn ? checkLine('sieve') : null,
				panel.sieveOn && panel.sieveOpen ? [hostPort('sieve', 'ManageSieve', d.sieve), securitySwitch('sieve', d.sieve, 'ManageSieve')] : null)),
		el('div', { class: 'ncm-panel-foot' },
			el('button', { type: 'button', class: 'ncm-btn', disabled: panel.checking, onclick: runCheck }, svg('refresh', 16), panel.checks ? 'Check again' : 'Check connection'),
			el('div', { class: 'ncm-foot-right' },
				el('button', { type: 'button', class: 'ncm-btn', onclick: close }, 'Cancel'),
				el('button', { type: 'submit', class: 'ncm-btn primary' }, isNew ? 'Add server' : 'Save changes'))))
		setTimeout(() => { if (panel && !form.contains(document.activeElement)) (isNew ? name : form.querySelector('.ncm-panel-head button')).focus() }, 0)
		return el('div', { class: 'ncm-overlay', onmousedown: (e) => { if (e.target === e.currentTarget) close() } }, form)
	}

	// ---- dialog: add a server, starting from a domain ----
	function modalView() {
		const m = modal
		const close = () => { modal = null; render() }
		const manual = () => {
			const dom = cleanDomain(m.domain)
			const f = m.step === 'found' ? m.found : null
			openPanel(-1, {
				id: 'srv-' + Date.now().toString(36), name: m.name || '', domains: dom ? [dom] : [], username: m.username || (f && f.username) || 'email',
				imap: f ? clone(f.imap) : { host: dom ? 'imap.' + dom : '', port: 993, security: 'tls' },
				smtp: f ? clone(f.smtp) : { host: dom ? 'smtp.' + dom : '', port: 465, security: 'tls' },
				sieve: f && f.sieve ? clone(f.sieve) : undefined,
			}, f ? m.status : null)
		}
		const lookup = async (ev) => {
			ev.preventDefault()
			if (!cleanDomain(m.domain)) return
			m.step = 'busy'; m.error = null; render()
			try {
				const r = await request('POST', '/discover', { domain: cleanDomain(m.domain) })
				if (modal !== m) return
				if (!r.found) { m.step = 'none'; m.found = null } else {
					m.step = 'found'; m.found = r.found; m.status = r.status
					m.name = r.found.name || cleanDomain(m.domain).split('.')[0].replace(/^./, (c) => c.toUpperCase()) + ' mail'
					m.username = r.found.username
				}
			} catch (e) { m.step = 'ask'; m.error = e.message }
			render()
		}
		const add = () => {
			const f = m.found
			const entry = { id: 'srv-' + Date.now().toString(36), name: (m.name || '').trim() || cleanDomain(m.domain), domains: [cleanDomain(m.domain)], username: m.username || 'email', imap: f.imap, smtp: f.smtp }
			if (f.sieve) entry.sieve = f.sieve
			save({ ...view.admin, servers: view.admin.servers.concat(entry) }, 'Added ' + entry.name + '.')
		}
		const domain = el('input', { type: 'text', class: 'ncm-input big', value: m.domain, placeholder: 'example.com', id: 'ncm-domain', spellcheck: 'false', disabled: m.step === 'busy' })
		domain.addEventListener('input', () => { m.domain = domain.value })
		const foundRow = (label, srv, st, proto) => {
			const tone = toneOf(st)
			return el('div', { class: 'ncm-found' },
				el('strong', {}, label),
				el('span', { class: 'ncm-found-srv' }, el('span', { class: 'ncm-mono' }, srv.host), el('span', { class: 'ncm-sub' }, proto + ' · ' + srv.port + ' · ' + SEC[srv.security])),
				st ? el('span', { class: 'ncm-status ' + tone }, svg(tone === 'ok' ? 'check' : 'alert', 13), !st.ok ? 'Not answering' : st.warning === 'plain' ? 'Not encrypted' : st.warning ? 'Certificate expires soon' : 'Answers') : null)
		}
		const f = m.found
		const source = f && ({ autoconfig: 'From the domain\'s own autoconfig file (' + f.from + ').', srv: 'From the ' + f.from + '.', ispdb: 'From ' + f.from + '.' })[f.source]
		const allOk = m.status && m.status.imap.ok && m.status.smtp.ok
		const nameIn = el('input', { type: 'text', class: 'ncm-input', value: m.name || '', id: 'ncm-found-name' })
		nameIn.addEventListener('input', () => { m.name = nameIn.value })
		const login = el('select', { class: 'ncm-input', id: 'ncm-found-login' },
			[['email', 'Email address'], ['local', 'Before the @'], ['uid', 'Nextcloud user']].map(([k, v]) => el('option', { value: k, selected: m.username === k }, v)))
		login.addEventListener('change', () => { m.username = login.value })

		const dialog = el('div', { class: 'ncm-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Add mail server', onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); close() } } },
			el('div', { class: 'ncm-modal-body' },
				el('h3', {}, 'Add mail server'),
				el('p', { class: 'ncm-lead' }, 'Enter a domain your people use. Mail looks up its servers, so you usually only have to confirm.'),
				el('form', { class: 'ncm-lookup', onsubmit: lookup },
					el('label', { class: 'ncm-field', for: 'ncm-domain' }, el('span', { class: 'ncm-label' }, 'Email domain'), domain),
					el('button', { type: 'submit', class: 'ncm-btn big', disabled: m.step === 'busy' }, m.step === 'busy' ? 'Looking up…' : 'Look up')),
				m.error ? el('p', { class: 'ncm-flash error', role: 'alert' }, m.error) : null,
				m.step === 'none' ? el('div', { class: 'ncm-info warn', role: 'status' }, el('strong', {}, 'No published settings for ' + cleanDomain(m.domain)), el('span', { class: 'ncm-sub' }, 'The domain has no autoconfig file or mail DNS records. Enter the servers yourself; your mail provider\'s help pages list them.')) : null,
				m.step === 'found' ? [
					el('div', { class: 'ncm-info' + (allOk ? '' : ' warn'), role: 'status' },
						el('strong', {}, svg(allOk ? 'check' : 'alert', 16), allOk ? 'Found the servers for ' + cleanDomain(m.domain) : 'Found settings, but not everything answers'),
						el('span', { class: 'ncm-sub' }, source + (allOk ? ' Each server was checked and answers.' : ' Check them before adding.'))),
					el('div', { class: 'ncm-founds' },
						foundRow('Incoming', f.imap, m.status.imap, 'IMAP'),
						foundRow('Outgoing', f.smtp, m.status.smtp, 'SMTP'),
						f.sieve ? foundRow('Filters', f.sieve, m.status.sieve, 'ManageSieve') : null),
					el('div', { class: 'ncm-two' },
						el('label', { class: 'ncm-field', for: 'ncm-found-name' }, el('span', { class: 'ncm-label' }, 'Name people see'), nameIn),
						el('label', { class: 'ncm-field', for: 'ncm-found-login' }, el('span', { class: 'ncm-label' }, 'Sign in with'), login))] : null),
			el('div', { class: 'ncm-modal-foot' },
				el('button', { type: 'button', class: 'ncm-link', onclick: manual }, m.step === 'found' ? 'Edit these settings' : 'Enter the servers myself'),
				el('div', { class: 'ncm-foot-right' },
					el('button', { type: 'button', class: 'ncm-btn', onclick: close }, 'Cancel'),
					m.step === 'found' ? el('button', { type: 'button', class: 'ncm-btn primary', onclick: add }, 'Add server') : null)))
		setTimeout(() => { if (modal && !dialog.contains(document.activeElement)) (m.step === 'found' ? nameIn : domain).focus() }, 0)
		return el('div', { class: 'ncm-overlay center', onmousedown: (e) => { if (e.target === e.currentTarget) close() } }, dialog)
	}

	root.replaceChildren(el('h2', {}, 'Mail servers'), el('p', { class: 'ncm-sub' }, 'Loading…'))
	const loadVersions = fetch(OC.generateUrl('/apps/ncmail/admin/versions'), { headers: { requesttoken: OC.requestToken, Accept: 'application/json' } })
		.then((r) => (r.ok ? r.json() : null)).then((v) => { versions = v }).catch(() => {})
	Promise.all([request('GET', ''), loadVersions]).then(([d]) => { view = d; render() }).catch(async (e) => {
		await loadVersions
		root.replaceChildren(...[el('h2', {}, 'Mail servers'), versionNote(), el('p', { class: 'ncm-flash error' }, e.message)].filter(Boolean))
	})
})()
