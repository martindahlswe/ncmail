<?php

declare(strict_types=1);

namespace OCA\NcMail\Settings;

use OCA\NcMail\Service\Keys;
use OCA\NcMail\Service\MailClient;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\Settings\ISettings;
use OCP\Util;

/** Shows what the mail service needs to trust this Nextcloud, and the mail servers set up for everybody (js/admin.js). */
class Admin implements ISettings {
	public function __construct(private Keys $keys, private MailClient $mail) {
	}

	public function getForm(): TemplateResponse {
		$k = $this->keys->publicKeys()[0];
		Util::addScript('ncmail', 'admin');
		Util::addStyle('ncmail', 'admin');
		return new TemplateResponse('ncmail', 'admin', ['url' => $this->mail->publicUrl(), 'kid' => $k['kid'], 'publicKey' => $k['publicKey']], '');
	}

	public function getSection(): string {
		return 'ncmail';
	}

	public function getPriority(): int {
		return 10;
	}
}
