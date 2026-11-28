<?php

declare(strict_types=1);

namespace OCA\NcMail\BackgroundJob;

use OCA\NcMail\Service\MailClient;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\IJob;
use OCP\BackgroundJob\TimedJob;
use OCP\IUserManager;
use OCP\Notification\IManager;

/**
 * Asks the mail service about new mail about once a minute (as often as Nextcloud's background jobs run) and shows it in
 * Nextcloud's notifications. The service hands each message out once, and reports it again once it has been read, moved or
 * deleted, so its notification goes away. More than a few at once for one user become a single summary.
 */
class NewMailJob extends TimedJob {
	private const SINGLE_MAX = 3;

	public function __construct(
		ITimeFactory $time,
		private MailClient $mail,
		private IManager $notifications,
		private IUserManager $users,
	) {
		parent::__construct($time);
		$this->setInterval(60);
		$this->setTimeSensitivity(IJob::TIME_SENSITIVE);
	}

	protected function run($argument): void {
		$r = $this->mail->call('POST', '/api/internal/notifications', [], [], 10.0);
		if ($r === null) {
			return; // the service is unreachable: it keeps the mail for the next run
		}
		foreach ($r['done'] ?? [] as $d) {
			$this->take((string)($d['uid'] ?? ''), 'message', (string)($d['id'] ?? ''));
		}
		$byUser = [];
		foreach ($r['new'] ?? [] as $m) {
			$byUser[(string)($m['uid'] ?? '')][] = $m;
		}
		$shouldFlush = $this->notifications->defer();
		try {
			foreach ($byUser as $uid => $items) {
				if ($uid === '' || !$this->users->userExists($uid)) {
					continue;
				}
				if (count($items) > self::SINGLE_MAX) {
					$this->take($uid, 'summary', 'new');
					$n = $this->base($uid)->setObject('summary', 'new')->setSubject('new_mail_many', ['count' => count($items)]);
					$this->notifications->notify($n);
					continue;
				}
				foreach ($items as $m) {
					$n = $this->base($uid)
						->setObject('message', (string)$m['id'])
						->setSubject('new_mail', ['from' => (string)($m['from'] ?? ''), 'subject' => mb_substr((string)($m['subject'] ?? ''), 0, 200)]);
					if (!empty($m['date'])) {
						try {
							$n->setDateTime(new \DateTime((string)$m['date']));
						} catch (\Throwable) {
						}
					}
					$this->notifications->notify($n);
				}
			}
		} finally {
			if ($shouldFlush) {
				$this->notifications->flush();
			}
		}
	}

	private function base(string $uid) {
		return $this->notifications->createNotification()->setApp('ncmail')->setUser($uid)->setDateTime(new \DateTime());
	}

	private function take(string $uid, string $type, string $id): void {
		if ($uid === '' || $id === '') {
			return;
		}
		$n = $this->notifications->createNotification()->setApp('ncmail')->setUser($uid)->setObject($type, $id);
		$this->notifications->markProcessed($n);
	}
}
