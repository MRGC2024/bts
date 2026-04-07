<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

if (is_file(dirname(__DIR__) . '/lib/local.php')) {
    require_once dirname(__DIR__) . '/lib/local.php';
}

require_once dirname(__DIR__) . '/lib/Store.php';
require_once dirname(__DIR__) . '/lib/Integrations.php';

/** @return never */
function bts_json(int $code, array $body): void
{
    http_response_code($code);
    echo json_encode($body, JSON_UNESCAPED_UNICODE);
    exit;
}

function bts_uuid(): string
{
    $b = random_bytes(16);
    $b[6] = chr(ord($b[6]) & 0x0f | 0x40);
    $b[8] = chr(ord($b[8]) & 0x3f | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

function bts_public_token(): string
{
    return substr(str_replace('-', '', bts_uuid()), 0, 16);
}

function bts_fake_purchase_id(): string
{
    return 'TM-BR-' . (string) random_int(100000, 999999);
}

function bts_client_ip(): string
{
    $xff = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
    if (is_string($xff) && $xff !== '') {
        $parts = explode(',', $xff);
        return trim($parts[0]);
    }
    return (string) ($_SERVER['REMOTE_ADDR'] ?? '');
}

function bts_env_admin_password(): string
{
    if (defined('BTS_ADMIN_PASSWORD') && is_string(BTS_ADMIN_PASSWORD)) {
        return BTS_ADMIN_PASSWORD;
    }
    $e = getenv('BTS_ADMIN_PASSWORD');
    return is_string($e) ? $e : '';
}

/** @param array<string,mixed> $cfg */
function bts_public_cfg(array $cfg): array
{
    $max = (int) ($cfg['maxTicketsPerOrder'] ?? 4);
    if ($max < 1) {
        $max = 4;
    }
    if ($max > 99) {
        $max = 99;
    }
    return [
        'ga4MeasurementId' => (string) ($cfg['ga4MeasurementId'] ?? ''),
        'googleAdsConversionId' => (string) ($cfg['googleAdsConversionId'] ?? ''),
        'googleAdsConversionLabel' => (string) ($cfg['googleAdsConversionLabel'] ?? ''),
        'maxTicketsPerOrder' => $max,
        'platformName' => (string) ($cfg['platformName'] ?? 'BTSIngressos'),
    ];
}

/** @param array<string,mixed> $cfg */
function bts_fix_public_cfg_keys(array $cfg): array
{
    return $cfg;
}

/** @return array<string,array{label:string,color:string,inteira:int,meia:int}> */
function bts_sectors(): array
{
    return [
        'arquib' => ['label' => 'Arquibancada', 'color' => '#e02020', 'inteira' => 68000, 'meia' => 34000],
        'sup' => ['label' => 'Cadeira Superior', 'color' => '#ff9800', 'inteira' => 98000, 'meia' => 49000],
        'inf' => ['label' => 'Cadeira Inferior', 'color' => '#00bcd4', 'inteira' => 108000, 'meia' => 54000],
        'pista' => ['label' => 'Pista', 'color' => '#0d47a1', 'inteira' => 125000, 'meia' => 62500],
    ];
}

function bts_bearer_token(): string
{
    $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if (!is_string($h)) {
        return '';
    }
    if (preg_match('/Bearer\s+(.+)/i', $h, $m)) {
        return trim($m[1]);
    }
    return '';
}

/** @param array<string,mixed> $cfg */
function bts_assert_admin(array $cfg): void
{
    $token = bts_bearer_token();
    if ($token === '') {
        bts_json(401, ['error' => 'Não autorizado']);
    }
    $env = bts_env_admin_password();
    if ($env !== '' && hash_equals($env, $token)) {
        return;
    }
    $hash = (string) ($cfg['adminPasswordHash'] ?? '');
    if ($hash !== '' && password_verify($token, $hash)) {
        return;
    }
    bts_json(401, ['error' => 'Não autorizado']);
}

/** @return array<string,mixed> */
function bts_json_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }
    $j = json_decode($raw, true);
    return is_array($j) ? $j : [];
}

$route = isset($_GET['route']) ? trim((string) $_GET['route'], '/') : '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

$cfg = bts_fix_public_cfg_keys(BtsStore::loadConfig());

if ($route === 'public-config' && $method === 'GET') {
    bts_json(200, bts_public_cfg($cfg));
}

if ($route === 'sectors' && $method === 'GET') {
    bts_json(200, [
        'sectors' => bts_sectors(),
        'maxTicketsPerOrder' => bts_public_cfg($cfg)['maxTicketsPerOrder'],
    ]);
}

if ($route === 'admin/login' && $method === 'POST') {
    $body = bts_json_body();
    $pass = (string) ($body['password'] ?? '');
    $env = bts_env_admin_password();

    if ($env !== '' && hash_equals($env, $pass)) {
        bts_json(200, ['token' => $pass, 'ok' => true]);
    }

    $hash = (string) ($cfg['adminPasswordHash'] ?? '');
    if ($hash !== '' && $pass !== '' && password_verify($pass, $hash)) {
        bts_json(200, ['token' => $pass, 'ok' => true]);
    }

    if ($hash === '' && $env === '' && strlen($pass) >= 6) {
        BtsStore::saveConfig([
            'adminPasswordHash' => password_hash($pass, PASSWORD_BCRYPT),
        ]);
        bts_json(200, ['token' => $pass, 'ok' => true]);
    }

    bts_json(401, ['error' => 'Senha inválida']);
}

if ($route === 'admin/config' && $method === 'GET') {
    bts_assert_admin($cfg);
    $cfg = BtsStore::loadConfig();
    $cfg['quantumSecretKey'] = ($cfg['quantumSecretKey'] ?? '') !== '' ? '********' : '';
    $cfg['utmifyApiToken'] = ($cfg['utmifyApiToken'] ?? '') !== '' ? '********' : '';
    bts_json(200, $cfg);
}

if ($route === 'admin/config' && $method === 'PUT') {
    bts_assert_admin($cfg);
    $body = bts_json_body();
    $prev = BtsStore::loadConfig();
    $next = $prev;

    $fields = [
        'quantumPublicKey', 'quantumApiBase', 'quantumAmountUnit',
        'quantumEventName', 'quantumItemTitleTemplate', 'quantumItemTitleTemplateBundle',
        'utmifyApiToken',
        'ga4MeasurementId', 'googleAdsConversionId', 'googleAdsConversionLabel',
        'maxTicketsPerOrder', 'platformName', 'publicBaseUrl',
    ];
    foreach ($fields as $f) {
        if (array_key_exists($f, $body)) {
            $next[$f] = $body[$f];
        }
    }
    if (!empty($body['quantumSecretKey']) && $body['quantumSecretKey'] !== '********') {
        $next['quantumSecretKey'] = $body['quantumSecretKey'];
    }
    if (!empty($body['utmifyApiToken']) && $body['utmifyApiToken'] !== '********') {
        $next['utmifyApiToken'] = $body['utmifyApiToken'];
    }
    if (!empty($body['newAdminPassword']) && strlen((string) $body['newAdminPassword']) >= 6) {
        $next['adminPasswordHash'] = password_hash((string) $body['newAdminPassword'], PASSWORD_BCRYPT);
    }

    BtsStore::saveConfig($next);
    bts_json(200, ['ok' => true, 'config' => bts_public_cfg($next)]);
}

if ($route === 'admin/orders' && $method === 'GET') {
    bts_assert_admin($cfg);
    bts_json(200, ['orders' => BtsStore::loadOrders()]);
}

if ($route === 'checkout/create' && $method === 'POST') {
    try {
        $body = bts_json_body();
        $cfg = BtsStore::loadConfig();
        $maxT = bts_public_cfg($cfg)['maxTicketsPerOrder'];
        $sectors = bts_sectors();

        $lote = (string) ($body['lote'] ?? '');
        $sectorId = (string) ($body['sectorId'] ?? '');
        $ticketType = (($body['ticketType'] ?? '') === 'meia') ? 'meia' : 'inteira';
        $quantity = max(1, min($maxT, (int) ($body['quantity'] ?? 1)));

        if (!isset($sectors[$sectorId])) {
            bts_json(400, ['error' => 'Setor inválido']);
        }
        $sec = $sectors[$sectorId];
        $unit = $sec[$ticketType];
        $totalCents = $unit * $quantity;

        $customerName = trim((string) ($body['customerName'] ?? ''));
        $customerEmail = trim((string) ($body['customerEmail'] ?? ''));
        $customerDocument = preg_replace('/\D/', '', (string) ($body['customerDocument'] ?? ''));

        if ($customerName === '' || $customerEmail === '' || $customerDocument === '') {
            bts_json(400, ['error' => 'Preencha nome, e-mail e CPF']);
        }

        $publicBase = (string) ($cfg['publicBaseUrl'] ?? '');
        if ($publicBase === '') {
            $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
            $host = (string) ($_SERVER['HTTP_HOST'] ?? 'localhost');
            $publicBase = $scheme . '://' . $host;
            $basePath = rtrim(str_replace('\\', '/', dirname(dirname($_SERVER['SCRIPT_NAME'] ?? '/'))), '/');
            if ($basePath !== '' && $basePath !== '/') {
                $publicBase .= $basePath;
            }
        }
        $publicBase = rtrim($publicBase, '/');

        $order = [
            'id' => bts_uuid(),
            'publicToken' => bts_public_token(),
            'fakePurchaseId' => bts_fake_purchase_id(),
            'requestId' => 'SOL-' . strtoupper(base_convert((string) time(), 10, 36)) . '-' . strtoupper(substr(bin2hex(random_bytes(4)), 0, 4)),
            'lote' => $lote,
            'sectorId' => $sectorId,
            'sectorLabel' => $sec['label'],
            'ticketType' => $ticketType,
            'quantity' => $quantity,
            'unitPriceCents' => $unit,
            'totalCents' => $totalCents,
            'status' => 'pending',
            'customerName' => $customerName,
            'customerEmail' => $customerEmail,
            'customerPhone' => trim((string) ($body['customerPhone'] ?? '')),
            'customerDocument' => $customerDocument,
            'customerIp' => bts_client_ip(),
            'tracking' => is_array($body['tracking'] ?? null) ? $body['tracking'] : [],
            'quantumTransactionId' => null,
            'pixQrCode' => null,
            'pixExpiresAt' => null,
            'paidAt' => null,
            'createdAt' => gmdate('c'),
            'updatedAt' => gmdate('c'),
        ];

        BtsStore::appendOrder($order);

        error_log('[BTS][checkout][validated] orderId=' . $order['id'] . ' sectorId=' . $sectorId
            . ' totalCents=' . $totalCents . ' publicBase=' . $publicBase
            . ' quantumAmountUnit=' . ($cfg['quantumAmountUnit'] ?? 'cents')
            . ' hasQuantumKeys=' . ((trim((string) ($cfg['quantumPublicKey'] ?? '')) !== '' && trim((string) ($cfg['quantumSecretKey'] ?? '')) !== '') ? '1' : '0'));

        try {
            BtsIntegrations::sendUtmifyOrder($cfg, $order, 'waiting_payment');
        } catch (Throwable $e) {
            error_log('[BTS][checkout][utmify] ' . $e->getMessage());
        }

        try {
            $quantumData = BtsIntegrations::createQuantumPix($cfg, $order, $publicBase);
        } catch (Throwable $e) {
            $code = (int) $e->getCode();
            error_log('[BTS][checkout][quantum_throw] orderId=' . $order['id'] . ' code=' . $code . ' msg=' . $e->getMessage());
            BtsStore::updateOrder($order['id'], [
                'status' => 'gateway_error',
                'gatewayError' => $e->getMessage(),
            ]);
            $errKey = $code === 1001 ? 'quantum_config' : ($code === 1002 ? 'quantum_network' : 'quantum_upstream');
            if ($errKey === 'quantum_config') {
                $hint = ' Configure chave pública e secreta em Gateway PIX.';
            } elseif ($errKey === 'quantum_network') {
                $hint = ' Verifique rede/DNS do servidor.';
            } else {
                $hint = ' Se o manual pedir valor em reais, altere “Valores na Quantum” no painel.';
            }
            bts_json(424, [
                'error' => 'Falha ao gerar PIX no gateway.' . $hint . ' Resposta: ' . $e->getMessage(),
                'code' => $errKey,
                'orderId' => $order['id'],
            ]);
        }

        $tx = $quantumData['data'] ?? $quantumData;
        $pix = is_array($tx['pix'] ?? null) ? $tx['pix'] : [];
        $pixCode = BtsIntegrations::extractPixCode($quantumData);

        $feeCent = 0;
        if (isset($tx['fee']['estimatedFee'])) {
            $feeCent = (int) round((float) $tx['fee']['estimatedFee'] * 100);
        }

        if ($pixCode === null || $pixCode === '') {
            error_log('[Quantum] transação sem código PIX: ' . substr(json_encode($tx, JSON_UNESCAPED_UNICODE), 0, 2000));
            BtsStore::updateOrder($order['id'], [
                'status' => 'gateway_error',
                'gatewayError' => 'Resposta Quantum sem qrcode/copyPaste',
                'quantumRaw' => $tx,
            ]);
            bts_json(424, [
                'error' => 'O gateway respondeu, mas não veio código PIX. Confira o formato na documentação Quantum.',
                'code' => 'quantum_missing_pix',
                'orderId' => $order['id'],
            ]);
        }

        BtsStore::updateOrder($order['id'], [
            'status' => 'waiting_payment',
            'quantumTransactionId' => $tx['id'] ?? $quantumData['id'] ?? null,
            'quantumRaw' => $tx,
            'pixQrCode' => $pixCode,
            'pixExpiresAt' => $pix['expirationDate'] ?? $pix['expiresAt'] ?? null,
            'gatewayFeeInCents' => $feeCent,
        ]);

        $fresh = BtsStore::findOrderById($order['id']);
        if ($fresh === null) {
            bts_json(500, ['error' => 'Pedido não encontrado após criar']);
        }

        bts_json(200, [
            'orderId' => $fresh['id'],
            'publicToken' => $fresh['publicToken'],
            'pixQrCode' => $fresh['pixQrCode'],
            'expiresAt' => $fresh['pixExpiresAt'],
            'amountCents' => $fresh['totalCents'],
        ]);
    } catch (Throwable $e) {
        error_log('checkout: ' . $e->getMessage());
        bts_json(500, ['error' => $e->getMessage() ?: 'Erro interno']);
    }
}

if (preg_match('#^order/([^/]+)$#', $route, $m) && $method === 'GET') {
    $o = BtsStore::findOrderByPublicToken($m[1]);
    if ($o === null) {
        bts_json(404, ['error' => 'Pedido não encontrado']);
    }
    bts_json(200, [
        'id' => $o['id'],
        'publicToken' => $o['publicToken'],
        'fakePurchaseId' => $o['fakePurchaseId'] ?? null,
        'requestId' => $o['requestId'] ?? null,
        'status' => $o['status'],
        'lote' => $o['lote'],
        'sectorLabel' => $o['sectorLabel'],
        'ticketType' => $o['ticketType'],
        'quantity' => $o['quantity'],
        'unitPriceCents' => $o['unitPriceCents'],
        'totalCents' => $o['totalCents'],
        'customerName' => $o['customerName'],
        'customerEmail' => $o['customerEmail'],
        'paidAt' => $o['paidAt'] ?? null,
        'createdAt' => $o['createdAt'],
        'pixQrCode' => $o['pixQrCode'] ?? null,
    ]);
}

if ($route === 'webhook/quantum' && $method === 'POST') {
    http_response_code(200);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'ok';
    if (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request();
    }

    try {
        $raw = file_get_contents('php://input');
        $payload = json_decode((string) $raw, true);
        if (!is_array($payload)) {
            exit;
        }
        $data = $payload['data'] ?? $payload;
        if (!is_array($data)) {
            exit;
        }
        $externalRef = $data['externalRef'] ?? $data['external_ref'] ?? null;
        if (!$externalRef) {
            exit;
        }

        $order = BtsStore::findOrderById((string) $externalRef);
        if ($order === null) {
            exit;
        }

        $rawStatus = $data['status'] ?? '';
        $utStatus = BtsIntegrations::mapQuantumStatusToUtmify((string) $rawStatus);
        $paid = in_array(strtolower((string) $rawStatus), ['paid', 'approved'], true);

        BtsStore::updateOrder($order['id'], [
            'status' => $paid ? 'paid' : ((string) $rawStatus ?: (string) ($order['status'] ?? '')),
            'paidAt' => $paid ? gmdate('c') : ($order['paidAt'] ?? null),
            'webhookLast' => $data,
        ]);

        $cfg = BtsStore::loadConfig();
        $updated = BtsStore::findOrderById($order['id']);
        if ($updated !== null) {
            try {
                BtsIntegrations::sendUtmifyOrder($cfg, $updated, $utStatus);
            } catch (Throwable $e) {
                error_log('Utmify webhook: ' . $e->getMessage());
            }
        }
    } catch (Throwable $e) {
        error_log('webhook quantum: ' . $e->getMessage());
    }
    exit;
}

bts_json(404, ['error' => 'Not found']);
