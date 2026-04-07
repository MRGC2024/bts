<?php

declare(strict_types=1);

final class BtsStore
{
    private static function dataDir(): string
    {
        return dirname(__DIR__) . '/data';
    }

    private static function configPath(): string
    {
        return self::dataDir() . '/config.json';
    }

    private static function ordersPath(): string
    {
        return self::dataDir() . '/orders.json';
    }

    /** @return array<string,mixed> */
    public static function defaultConfig(): array
    {
        return [
            'quantumPublicKey' => '',
            'quantumSecretKey' => '',
            'quantumApiBase' => 'https://api.quantumpayments.com.br/v1',
            'utmifyApiToken' => '',
            'ga4MeasurementId' => '',
            'googleAdsConversionId' => '',
            'googleAdsConversionLabel' => '',
            'maxTicketsPerOrder' => 4,
            'adminPasswordHash' => '',
            'platformName' => 'BTSIngressos',
            'publicBaseUrl' => '',
        ];
    }

    private static function ensureDir(): void
    {
        $d = self::dataDir();
        if (!is_dir($d)) {
            mkdir($d, 0755, true);
        }
    }

    /** @return array<string,mixed> */
    public static function loadConfig(): array
    {
        self::ensureDir();
        $p = self::configPath();
        $def = self::defaultConfig();
        if (!is_file($p)) {
            file_put_contents($p, json_encode($def, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
            return $def;
        }
        $raw = file_get_contents($p);
        if ($raw === false) {
            return $def;
        }
        $j = json_decode($raw, true);
        if (!is_array($j)) {
            return $def;
        }
        return array_merge($def, $j);
    }

    /** @param array<string,mixed> $patch */
    public static function saveConfig(array $patch): array
    {
        self::ensureDir();
        $merged = array_merge(self::loadConfig(), $patch);
        file_put_contents(
            self::configPath(),
            json_encode($merged, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)
        );
        return $merged;
    }

    /** @return list<array<string,mixed>> */
    public static function loadOrders(): array
    {
        self::ensureDir();
        $p = self::ordersPath();
        if (!is_file($p)) {
            file_put_contents($p, '[]');
            return [];
        }
        $raw = file_get_contents($p);
        if ($raw === false) {
            return [];
        }
        $j = json_decode($raw, true);
        return is_array($j) ? $j : [];
    }

    /** @param list<array<string,mixed>> $orders */
    public static function saveOrders(array $orders): void
    {
        self::ensureDir();
        file_put_contents(
            self::ordersPath(),
            json_encode($orders, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)
        );
    }

    /** @param array<string,mixed> $order */
    public static function appendOrder(array $order): array
    {
        $orders = self::loadOrders();
        array_unshift($orders, $order);
        self::saveOrders($orders);
        return $order;
    }

    /** @param array<string,mixed> $patch */
    public static function updateOrder(string $orderId, array $patch): ?array
    {
        $orders = self::loadOrders();
        foreach ($orders as $i => $o) {
            if (($o['id'] ?? '') === $orderId) {
                $orders[$i] = array_merge($o, $patch, [
                    'updatedAt' => gmdate('c'),
                ]);
                self::saveOrders($orders);
                return $orders[$i];
            }
        }
        return null;
    }

    public static function findOrderById(string $id): ?array
    {
        foreach (self::loadOrders() as $o) {
            if (($o['id'] ?? '') === $id) {
                return $o;
            }
        }
        return null;
    }

    public static function findOrderByPublicToken(string $token): ?array
    {
        foreach (self::loadOrders() as $o) {
            if (($o['publicToken'] ?? '') === $token) {
                return $o;
            }
        }
        return null;
    }
}
