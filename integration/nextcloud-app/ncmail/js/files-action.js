/* "Send by mail" in Files: opens Mail's composer with the chosen files attached (Mail fetches them from your Nextcloud). */
(function () {
	'use strict'
	const READ = 1 // Nextcloud's read permission bit
	const MAX = 20 // Mail attaches at most this many files at once
	const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z"/></svg>'
	const t = (s) => (window.t ? window.t('ncmail', s) : s)

	const usable = (nodes, view) => Array.isArray(nodes) && nodes.length > 0 && nodes.length <= MAX
		&& (!view || view.id !== 'trashbin')
		&& nodes.every((n) => n && n.type === 'file' && (n.permissions & READ) !== 0 && typeof n.path === 'string')

	function open(nodes) {
		const url = window.OC.generateUrl('/apps/ncmail/') + '?attach=' + encodeURIComponent(JSON.stringify(nodes.map((n) => n.path)))
		window.location.assign(url)
	}

	const action = {
		id: 'ncmail-send-by-mail',
		displayName: () => t('Send by mail'),
		iconSvgInline: () => icon,
		enabled: (nodes, view) => usable(nodes, view),
		exec: async (node) => { open([node]); return null },
		execBatch: async (nodes) => { open(nodes); return nodes.map(() => null) },
		order: 25,
	}

	// the same registry @nextcloud/files' registerFileAction() writes to
	if (window._nc_fileactions === undefined) window._nc_fileactions = []
	if (!window._nc_fileactions.find((a) => a.id === action.id)) window._nc_fileactions.push(action)
})()
