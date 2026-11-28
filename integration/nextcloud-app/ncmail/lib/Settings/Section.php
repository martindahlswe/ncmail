<?php

declare(strict_types=1);

namespace OCA\NcMail\Settings;

use OCP\IURLGenerator;
use OCP\Settings\IIconSection;

/** "Mail" in Nextcloud's administration menu: the mail servers set up for everybody and the connection to the mail service. */
class Section implements IIconSection {
	public function __construct(private IURLGenerator $urls) {
	}

	public function getID(): string {
		return 'ncmail';
	}

	public function getName(): string {
		return 'Mail';
	}

	public function getPriority(): int {
		return 75;
	}

	public function getIcon(): string {
		return $this->urls->imagePath('ncmail', 'app-dark.svg');
	}
}
