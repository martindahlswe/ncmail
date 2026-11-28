<?php
/** @var array $_ */
?>
<div id="ncmail-wrap" data-origin="<?php p($_['origin']); ?>" data-open="<?php p($_['open']); ?>" data-token-url="<?php p($_['tokenUrl']); ?>" data-link-url="<?php p($_['linkUrl']); ?>">
	<iframe id="ncmail-frame" src="<?php p($_['url']); ?>" title="Mail" allow="clipboard-write"></iframe>
</div>
