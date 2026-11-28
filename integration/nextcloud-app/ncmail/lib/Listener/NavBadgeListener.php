<?php

declare(strict_types=1);

namespace OCA\NcMail\Listener;

use OCA\NcMail\Service\MailClient;
use OCP\AppFramework\Http\Events\BeforeTemplateRenderedEvent;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\ICacheFactory;
use OCP\INavigationManager;
use OCP\IUserSession;

/** Shows the number of unread inbox messages on Mail's menu entry. Looked up at most once a minute per user, and never blocks the page for long. */
class NavBadgeListener implements IEventListener {
	public function __construct(
		private MailClient $mail,
		private IUserSession $users,
		private INavigationManager $nav,
		private ICacheFactory $caches,
	) {
	}

	public function handle(Event $event): void {
		try {
			$this->badge($event);
		} catch (\Throwable) {
			// the badge is a nicety: never break the page for it
		}
	}

	private function badge(Event $event): void {
		if (!($event instanceof BeforeTemplateRenderedEvent) || !$event->isLoggedIn()) {
			return;
		}
		$user = $this->users->getUser();
		if ($user === null) {
			return;
		}
		$cache = $this->caches->createDistributed('ncmail');
		$key = 'unread-' . $user->getUID();
		$n = $cache->get($key);
		if ($n === null) {
			$r = $this->mail->call('GET', '/api/internal/unread', ['uid' => $user->getUID()], null, 1.5);
			$n = (int)($r['unread'] ?? 0);
			$cache->set($key, $n, 60);
		}
		if ($n > 0) {
			$this->nav->setUnreadCounter('ncmail', (int)$n);
		}
	}
}
