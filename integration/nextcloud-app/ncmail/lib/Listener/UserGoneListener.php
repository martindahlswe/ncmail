<?php

declare(strict_types=1);

namespace OCA\NcMail\Listener;

use OCA\NcMail\Service\MailClient;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\User\Events\BeforeUserLoggedOutEvent;
use OCP\User\Events\UserDeletedEvent;

/**
 * Tells the mail service the user signed out, so their Mail session ends at once instead of at its next renewal,
 * or that the user was removed, so everything the service keeps for them (accounts, mail, settings) is removed too.
 */
class UserGoneListener implements IEventListener {
	public function __construct(private MailClient $mail) {
	}

	public function handle(Event $event): void {
		// never let a problem here stop the sign-out or the removal
		if ($event instanceof UserDeletedEvent) {
			$this->mail->call('POST', '/api/internal/user-deleted', [], ['uid' => $event->getUser()->getUID()], 10.0);
		} elseif ($event instanceof BeforeUserLoggedOutEvent && $event->getUser() !== null) {
			$this->mail->call('POST', '/api/internal/logout', [], ['uid' => $event->getUser()->getUID()], 2.0);
		}
	}
}
