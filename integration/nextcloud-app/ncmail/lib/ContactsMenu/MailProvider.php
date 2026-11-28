<?php

declare(strict_types=1);

namespace OCA\NcMail\ContactsMenu;

use OCP\Contacts\ContactsMenu\IActionFactory;
use OCP\Contacts\ContactsMenu\IEntry;
use OCP\Contacts\ContactsMenu\IProvider;
use OCP\IURLGenerator;
use OCP\L10N\IFactory;

/** "Write an email" in Nextcloud's contacts menu (the header and avatars): opens Mail's composer addressed to the contact. */
class MailProvider implements IProvider {
	public function __construct(
		private IActionFactory $actions,
		private IURLGenerator $urls,
		private IFactory $l10n,
	) {
	}

	public function process(IEntry $entry): void {
		$l = $this->l10n->get('ncmail');
		$icon = $this->urls->getAbsoluteURL($this->urls->imagePath('ncmail', 'app-dark.svg'));
		$addresses = array_values(array_filter($entry->getEMailAddresses(), fn ($a) => is_string($a) && $a !== ''));
		foreach ($addresses as $address) {
			$name = count($addresses) > 1 ? $l->t('Write an email to %s', [$address]) : $l->t('Write an email');
			$href = $this->urls->linkToRouteAbsolute('ncmail.page.index', ['compose' => $address]);
			$entry->addAction($this->actions->newLinkAction($icon, $name, $href, 'ncmail'));
		}
	}
}
