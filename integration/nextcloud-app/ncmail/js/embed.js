/* Connects Nextcloud's page to the mail app in the frame: hands it a signed token for the signed-in user, renews it, and passes on theme and links. */
(function () {
	'use strict'
	const wrap = document.getElementById('ncmail-wrap')
	const frame = document.getElementById('ncmail-frame')
	if (!wrap || !frame) return
	const origin = wrap.dataset.origin
	const open = JSON.parse(wrap.dataset.open || '{}')
	const csrf = () => document.head.dataset.requesttoken || ''
	const send = (msg) => frame.contentWindow && frame.contentWindow.postMessage(msg, origin)

	async function sendToken() {
		try {
			const r = await fetch(wrap.dataset.tokenUrl, { headers: { requesttoken: csrf(), 'OCS-APIRequest': 'true' }, credentials: 'same-origin' })
			if (!r.ok) throw new Error(String(r.status))
			const j = await r.json()
			send({ type: 'ncmail:token', token: j.token })
		} catch (e) {
			send({ type: 'ncmail:no-session' }) // the Nextcloud session has ended: Mail ends with it
		}
	}
	function sendTheme() {
		const themes = (document.body.dataset.themes || '').split(',')
		const dark = themes.includes('dark') || themes.includes('dark-highcontrast')
			|| (themes.includes('default') && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
		send({ type: 'ncmail:theme', dark, themes })
	}
	async function link() {
		try { await fetch(wrap.dataset.linkUrl, { method: 'POST', headers: { requesttoken: csrf(), 'OCS-APIRequest': 'true' }, credentials: 'same-origin' }) } catch (e) { /* the manual Connect button remains */ }
		send({ type: 'ncmail:link-done' })
	}

	window.addEventListener('message', (e) => {
		if (e.origin !== origin || e.source !== frame.contentWindow || !e.data || typeof e.data.type !== 'string') return
		switch (e.data.type) {
		case 'ncmail:hello': sendTheme(); sendToken(); break
		case 'ncmail:token-request': sendToken(); break
		case 'ncmail:ready': sendTheme(); if (Object.keys(open).length) send({ type: 'ncmail:navigate', open }); break
		case 'ncmail:need-link': link(); break
		}
	})
	// follow Nextcloud's light/dark switch
	if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sendTheme)
	new MutationObserver(sendTheme).observe(document.body, { attributes: true, attributeFilter: ['data-themes'] })
})()
