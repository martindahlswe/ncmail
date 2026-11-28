<?php

declare(strict_types=1);

namespace OCA\NcMail\Listener;

use OCA\Files\Event\LoadAdditionalScriptsEvent;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Util;

/** Adds "Send by mail" to Files (see js/files-action.js). */
class FilesScriptsListener implements IEventListener {
	public function handle(Event $event): void {
		if (!($event instanceof LoadAdditionalScriptsEvent)) {
			return;
		}
		Util::addInitScript('ncmail', 'files-action');
	}
}
