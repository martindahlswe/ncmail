<?php

declare(strict_types=1);

return [
	'routes' => [
		['name' => 'page#index', 'url' => '/', 'verb' => 'GET'],
		['name' => 'page#token', 'url' => '/token', 'verb' => 'GET'],
		['name' => 'page#key', 'url' => '/key', 'verb' => 'GET'],
		['name' => 'page#link', 'url' => '/link', 'verb' => 'POST'],
		['name' => 'admin#versions', 'url' => '/admin/versions', 'verb' => 'GET'],
		['name' => 'admin#servers', 'url' => '/admin/mail-servers', 'verb' => 'GET'],
		['name' => 'admin#saveServers', 'url' => '/admin/mail-servers', 'verb' => 'PUT'],
		['name' => 'admin#check', 'url' => '/admin/mail-servers/check', 'verb' => 'POST'],
		['name' => 'admin#checkAll', 'url' => '/admin/mail-servers/check-all', 'verb' => 'POST'],
		['name' => 'admin#discover', 'url' => '/admin/mail-servers/discover', 'verb' => 'POST'],
	],
];
