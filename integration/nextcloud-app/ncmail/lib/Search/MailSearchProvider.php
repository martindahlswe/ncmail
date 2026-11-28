<?php

declare(strict_types=1);

namespace OCA\NcMail\Search;

use OCA\NcMail\Service\MailClient;
use OCP\IL10N;
use OCP\IURLGenerator;
use OCP\IUser;
use OCP\Search\IProvider;
use OCP\Search\ISearchQuery;
use OCP\Search\SearchResult;
use OCP\Search\SearchResultEntry;

/** Nextcloud's search box also finds mail (from the copy the mail service keeps, so it is fast). Opens the message in Mail. */
class MailSearchProvider implements IProvider {
	public function __construct(private MailClient $mail, private IURLGenerator $urls, private IL10N $l) {
	}

	public function getId(): string {
		return 'ncmail';
	}

	public function getName(): string {
		return $this->l->t('Mail');
	}

	public function getOrder(string $route, array $routeParameters): int {
		return str_starts_with($route, 'ncmail.') ? -1 : 20;
	}

	public function search(IUser $user, ISearchQuery $query): SearchResult {
		$r = $this->mail->call('GET', '/api/internal/search', ['uid' => $user->getUID(), 'q' => $query->getTerm(), 'limit' => $query->getLimit()], null, 3.0);
		$entries = [];
		foreach ($r['items'] ?? [] as $m) {
			$entries[] = new SearchResultEntry(
				'', (string)$m['subject'] !== '' ? (string)$m['subject'] : $this->l->t('(no subject)'),
				(string)$m['from'] . ' · ' . substr((string)$m['date'], 0, 10),
				$this->urls->linkToRoute('ncmail.page.index', ['message' => $m['id']]),
				$this->urls->imagePath('ncmail', 'app-dark.svg'),
			);
		}
		return SearchResult::complete($this->getName(), $entries);
	}
}
