<?php
/** @var array $_ */
?>
<div class="section" id="ncmail-admin">
	<div id="ncmail-servers"></div>
	<details class="ncmail-connection">
		<summary>Connection to the mail service</summary>
		<p>Mail service: <code><?php p($_['url']); ?></code> (change with <code>occ config:app:set ncmail url --value=https://…</code>).</p>
		<p>This Nextcloud signs sign-in tokens for the mail service. The service fetches the public key by itself from
			<code>/index.php/apps/ncmail/key</code>; to pin it instead, set <code>NCMAIL_HANDOFF_PUBLIC_KEY</code> on the service to:</p>
		<p><code style="word-break: break-all"><?php p($_['publicKey']); ?></code> (key id <code><?php p($_['kid']); ?></code>)</p>
		<p>Rotate the key with <code>occ ncmail:rotate-key</code>.</p>
	</details>
</div>
