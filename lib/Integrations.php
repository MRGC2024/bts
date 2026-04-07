<?php

declare(strict_types=1);

final class BtsIntegrations
{
    private const UTMIFY_URL = 'https://api.utmify.com.br/api-credentials/orders';

    public static function formatUtmifyUtcDate(?string $isoOrDate): ?string
    {
        if ($isoOrDate === null || $isoOrDate === '') {
            return null;
        }
        $t = strtotime($isoOrDate);
        if ($t === false) {
            return null;
        }
        return gmdate('Y-m-d H:i:s', $t);
    }

    public static function mapQuantumStatusToUtmify(?string $status): string
    {
        $s = strtolower((string) $status);
        if (in_array($s, ['paid', 'approved'], true)) {
            return 'paid';
        }
        if ($s === 'refused') {
            return 'refused';
        }
        if ($s === 'refunded') {
            return 'refunded';
        }
        if ($s === 'chargeback') {
            return 'chargedback';
        }
        return 'waiting_payment';
    }

    /** @param array<string,mixed> $order */
    public static function sendUtmifyOrder(array $cfg, array $order, string $utmifyStatus): array
    {
        $token = trim((string) ($cfg['utmifyApiToken'] ?? ''));
        if ($token === '') {
            return ['skipped' => true, 'reason' => 'no_token'];
        }

        $createdAt = self::formatUtmifyUtcDate($order['createdAt'] ?? null)
            ?? self::formatUtmifyUtcDate(gmdate('c'));
        $approvedDate = $utmifyStatus === 'paid'
            ? (self::formatUtmifyUtcDate($order['paidAt'] ?? null) ?? self::formatUtmifyUtcDate(gmdate('c')))
            : null;

        $totalCents = (int) ($order['totalCents'] ?? 0);
        $gatewayFee = isset($order['gatewayFeeInCents']) ? (int) $order['gatewayFeeInCents'] : 0;
        $userComm = $totalCents - $gatewayFee;
        if ($userComm <= 0) {
            $userComm = $totalCents;
        }

        $tp = is_array($order['tracking'] ?? null) ? $order['tracking'] : [];
        $ticketType = ($order['ticketType'] ?? '') === 'meia' ? 'Meia' : 'Inteira';

        $body = [
            'orderId' => $order['id'],
            'platform' => (string) ($cfg['platformName'] ?? 'BTSIngressos'),
            'paymentMethod' => 'pix',
            'status' => $utmifyStatus,
            'createdAt' => $createdAt,
            'approvedDate' => $approvedDate,
            'refundedAt' => $utmifyStatus === 'refunded'
                ? self::formatUtmifyUtcDate($order['refundedAt'] ?? null)
                : null,
            'customer' => [
                'name' => $order['customerName'],
                'email' => $order['customerEmail'],
                'phone' => $order['customerPhone'] ?? null,
                'document' => $order['customerDocument'] ?? null,
                'country' => 'BR',
                'ip' => $order['customerIp'] ?? null,
            ],
            'products' => [[
                'id' => ($order['sectorId'] ?? '') . '-' . ($order['ticketType'] ?? ''),
                'name' => ($order['sectorLabel'] ?? '') . ' — ' . $ticketType . ' (' . ($order['lote'] ?? '') . ')',
                'planId' => $order['lote'] ?? null,
                'planName' => $order['lote'] ?? null,
                'quantity' => (int) ($order['quantity'] ?? 1),
                'priceInCents' => (int) round((float) ($order['unitPriceCents'] ?? 0)),
            ]],
            /*
            'trackingParameters' => [...]
            */
        ];

        $body['trackingParameters'] = [
            'src' => $tp['src'] ?? null,
            'sck' => $tp['sck'] ?? null,
            'utm_source' => $tp['utm_source'] ?? null,
            'utm_campaign' => $tp['utm_campaign'] ?? null,
            'utm_medium' => $tp['utm_medium'] ?? null,
            'utm_content' => $tp['utm_content'] ?? null,
            'utm_term' => $tp['utm_term'] ?? null,
        ];

        $body['commission'] = [
            'totalPriceInCents' => $totalCents,
            'gatewayFeeInCents' => $gatewayFee,
            'userCommissionInCents' => $userComm,
            'currency' => 'BRL',
        ];

        $ch = curl_init(self::UTMIFY_URL);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'x-api-token: ' . $token,
            ],
            CURLOPT_POSTFIELDS => json_encode($body, JSON_UNESCAPED_UNICODE),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 30,
        ]);
        $res = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($code < 200 || $code >= 300) {
            throw new RuntimeException('Utmify HTTP ' . $code . ': ' . substr((string) $res, 0, 500));
        }
        $dec = json_decode((string) $res, true);
        return is_array($dec) ? $dec : [];
    }

    /**
     * @param array<string,mixed> $quantumData
     */
    public static function extractPixCode(array $quantumData): ?string
    {
        $root = $quantumData['data'] ?? $quantumData;
        $pix = is_array($root['pix'] ?? null) ? $root['pix'] : [];
        if ($pix === [] && is_array($quantumData['pix'] ?? null)) {
            $pix = $quantumData['pix'];
        }
        $candidates = [
            $pix['qrcode'] ?? null,
            $pix['qrCode'] ?? null,
            $pix['qr_code'] ?? null,
            $pix['copyPaste'] ?? null,
            $pix['copy_paste'] ?? null,
            $pix['emv'] ?? null,
            is_array($pix['dynamicQrCode'] ?? null) ? ($pix['dynamicQrCode']['qrcode'] ?? null) : null,
            is_array($pix['qr'] ?? null) ? ($pix['qr']['payload'] ?? null) : null,
            $root['pixQrCode'] ?? null,
            $quantumData['pixQrCode'] ?? null,
            $root['brCode'] ?? null,
        ];
        foreach ($candidates as $c) {
            if (is_string($c) && $c !== '') {
                return $c;
            }
        }

        return null;
    }

    /** @param array<string,mixed> $order */
    public static function createQuantumPix(array $cfg, array $order, string $publicBaseUrl): array
    {
        $pub = trim((string) ($cfg['quantumPublicKey'] ?? ''));
        $sec = trim((string) ($cfg['quantumSecretKey'] ?? ''));
        if ($pub === '' || $sec === '') {
            throw new RuntimeException('Chaves Quantum ausentes no painel (pública e secreta).', 1001);
        }

        $base = rtrim((string) ($cfg['quantumApiBase'] ?? 'https://api.quantumpayments.com.br/v1'), '/');
        $auth = base64_encode($pub . ':' . $sec);
        $postbackUrl = rtrim($publicBaseUrl, '/') . '/api/webhook/quantum';

        $amountCents = (int) ($order['totalCents'] ?? 0);
        $qty = max(1, (int) ($order['quantity'] ?? 1));
        $unitCents = (int) round($amountCents / $qty);
        $unitFlag = strtolower((string) ($cfg['quantumAmountUnit'] ?? 'cents'));
        if ($unitFlag === 'reais') {
            $amountVal = round($amountCents / 100, 2);
            $unitVal = round($unitCents / 100, 2);
        } else {
            $amountVal = $amountCents;
            $unitVal = $unitCents;
        }

        $payload = [
            'amount' => $amountVal,
            'paymentMethod' => 'pix',
            'postbackUrl' => $postbackUrl,
            'externalRef' => $order['id'],
            'metadata' => json_encode([
                'orderId' => $order['id'],
                'lote' => $order['lote'],
                'sector' => $order['sectorId'],
            ], JSON_UNESCAPED_UNICODE),
            'customer' => [
                'name' => $order['customerName'],
                'email' => $order['customerEmail'],
                'phone' => preg_replace('/\D/', '', (string) ($order['customerPhone'] ?? '')) ?: null,
                'document' => [
                    'type' => 'cpf',
                    'number' => preg_replace('/\D/', '', (string) ($order['customerDocument'] ?? '')),
                ],
            ],
            'items' => [[
                'title' => ($order['sectorLabel'] ?? '') . ' (' . ($order['ticketType'] ?? '') . ')',
                'quantity' => $qty,
                'tangible' => false,
                'unitPrice' => $unitVal,
                'externalRef' => $order['id'] . '-item',
            ]],
        ];

        $ch = curl_init($base . '/transactions');
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => [
                'Authorization: Basic ' . $auth,
                'Content-Type: application/json',
                'Accept: application/json',
            ],
            CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_TIMEOUT => 55,
        ]);
        $res = curl_exec($ch);
        $errno = curl_errno($ch);
        $cerr = curl_error($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($res === false || $errno !== 0) {
            throw new RuntimeException('Rede ao contactar Quantum: ' . ($cerr ?: 'curl ' . $errno), 1002);
        }

        $data = json_decode((string) $res, true);
        if (!is_array($data)) {
            $data = ['raw' => substr((string) $res, 0, 800)];
        }
        if ($code < 200 || $code >= 300) {
            $msg = $data['message'] ?? $data['error'] ?? null;
            if (!is_string($msg)) {
                $msg = 'Quantum HTTP ' . $code;
            }
            error_log('[Quantum] HTTP ' . $code . ' ' . substr((string) $res, 0, 1200));
            $extra = '';
            if (isset($data['errors'])) {
                $extra = ' ' . substr(json_encode($data['errors'], JSON_UNESCAPED_UNICODE), 0, 400);
            }
            throw new RuntimeException($msg . $extra, 1003);
        }

        return $data;
    }
}
