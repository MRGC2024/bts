<?php
/**
 * Fallback HostGator: alguns planos priorizam index.php ou não acham só o index.html.
 * Entrega o mesmo painel (HTML estático).
 */
declare(strict_types=1);
header('Content-Type: text/html; charset=utf-8');
header('X-Robots-Tag: noindex, nofollow');
$p = __DIR__ . '/index.html';
if (!is_file($p)) {
    http_response_code(500);
    echo '<!doctype html><meta charset="utf-8"><p>index.html não encontrado na pasta admin.</p>';
    exit;
}
readfile($p);
