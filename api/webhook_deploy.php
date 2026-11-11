<?php
/**
 * =========================================================================
 * GITHUB WEBHOOK AUTO-DEPLOY ENDPOINT
 * Presensi Digital Panitia KIP 2026
 * URL: https://presenkip26.sikancuyy.my.id/api/webhook_deploy.php?secret=kip2026deploy
 * =========================================================================
 */

header('Content-Type: application/json; charset=utf-8');

$expectedSecret = 'kip2026deploy';
$providedSecret = $_GET['secret'] ?? $_POST['secret'] ?? '';

$headers = function_exists('getallheaders') ? getallheaders() : [];
$hubSignature = $headers['X-Hub-Signature-256'] ?? $headers['x-hub-signature-256'] ?? '';

if ($providedSecret !== $expectedSecret && empty($hubSignature)) {
    http_response_code(403);
    echo json_encode(['success' => false, 'message' => 'Unauthorized: Invalid deploy secret.']);
    exit;
}

$repoDir = dirname(__DIR__);
$output = [];
$returnCode = 0;

$cmd = "cd " . escapeshellarg($repoDir) . " && git fetch origin main && git reset --hard origin/main && chown -R www-data:www-data data && chmod -R 775 data 2>&1";
exec($cmd, $output, $returnCode);

if ($returnCode === 0) {
    echo json_encode([
        'success' => true,
        'message' => 'Deployment executed successfully via webhook',
        'output' => $output,
        'timestamp' => date('Y-m-d H:i:s')
    ]);
} else {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'Deployment command error',
        'output' => $output,
        'timestamp' => date('Y-m-d H:i:s')
    ]);
}

