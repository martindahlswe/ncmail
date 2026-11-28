<?php

declare(strict_types=1);

namespace OCA\NcMail\Notification;

use OCP\IURLGenerator;
use OCP\L10N\IFactory;
use OCP\Notification\INotification;
use OCP\Notification\INotifier;
use OCP\Notification\UnknownNotificationException;

/** Turns the stored "new mail" notifications into text and a link that opens the message in Mail. */
class Notifier implements INotifier {
	public function __construct(
		private IFactory $l10n,
		private IURLGenerator $urls,
	) {
	}

	public function getID(): string {
		return 'ncmail';
	}

	public function getName(): string {
		return $this->l10n->get('ncmail')->t('Mail');
	}

	public function prepare(INotification $notification, string $languageCode): INotification {
		if ($notification->getApp() !== 'ncmail') {
			throw new UnknownNotificationException();
		}
		$l = $this->l10n->get('ncmail', $languageCode);
		$p = $notification->getSubjectParameters();
		$notification->setIcon($this->urls->getAbsoluteURL($this->urls->imagePath('ncmail', 'app-dark.svg')));
		switch ($notification->getSubject()) {
			case 'new_mail':
				$from = (string)($p['from'] ?? '');
				$notification->setParsedSubject($from !== '' ? $l->t('New mail from %s', [$from]) : $l->t('New mail'));
				$subject = (string)($p['subject'] ?? '');
				$notification->setParsedMessage($subject !== '' ? $subject : $l->t('(no subject)'));
				$notification->setLink($this->urls->linkToRouteAbsolute('ncmail.page.index', ['message' => $notification->getObjectId()]));
				return $notification;
			case 'new_mail_many':
				$n = (int)($p['count'] ?? 0);
				$notification->setParsedSubject($l->n('%n new message', '%n new messages', $n));
				$notification->setLink($this->urls->linkToRouteAbsolute('ncmail.page.index'));
				return $notification;
		}
		throw new UnknownNotificationException();
	}
}
