<?php
/**
 * Redireciona a raiz do domínio para a home do evento.
 * Em subpasta, o caminho é calculado automaticamente.
 */
$base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '')), '/');
$target = ($base === '' ? '' : $base) . '/event/bts-world-tour-arirang.html';
header('Location: ' . $target, true, 302);
exit;
