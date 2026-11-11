<?php
/**
 * Komunikasi Google Apps Script (GSheet Client Wrapper)
 * Mendukung 302 Redirect otomatis (Google usercontent) dan SSL verification
 */

require_once __DIR__ . '/config.php';

class GSheetClient {
    /**
     * Eksekusi HTTP Request ke GAS Web App
     */
    private static function request(string $method, array $params = [], ?array $body = null, int $timeout = 15): array {
        $baseUrl = getGasUrl();
        if (empty($baseUrl)) {
            return ['success' => false, 'message' => 'URL Google Apps Script belum dikonfigurasi'];
        }

        $url = $baseUrl;
        if (!empty($params)) {
            $queryString = http_build_query($params);
            $url .= (strpos($url, '?') !== false ? '&' : '?') . $queryString;
        }

        $ch = curl_init();
        curl_setopt($ch, CURLOPT_URL, $url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        curl_setopt($ch, CURLOPT_MAXREDIRS, 5);
        curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 6);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
        curl_setopt($ch, CURLOPT_USERAGENT, 'KIP2026-PHP-Cache/2.0');

        if (strtoupper($method) === 'POST') {
            curl_setopt($ch, CURLOPT_POST, true);
            $jsonBody = json_encode($body ?? $params, JSON_UNESCAPED_UNICODE);
            curl_setopt($ch, CURLOPT_POSTFIELDS, $jsonBody);
            curl_setopt($ch, CURLOPT_HTTPHEADER, [
                'Content-Type: application/json',
                'Content-Length: ' . strlen($jsonBody)
            ]);
        }

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError = curl_error($ch);
        curl_close($ch);

        if ($response === false || !empty($curlError)) {
            return [
                'success' => false,
                'message' => 'Koneksi ke Google Sheets terganggu: ' . $curlError,
                'http_code' => $httpCode
            ];
        }

        $data = json_decode($response, true);
        if (!is_array($data)) {
            // Jika respons bukan JSON valid (misal HTML auth error)
            return [
                'success' => false,
                'message' => 'Respons Google Sheets tidak berupa format JSON yang valid.',
                'raw_response' => substr($response, 0, 300)
            ];
        }

        return $data;
    }

    /**
     * Ambil agenda aktif dari GSheet
     */
    public static function getActiveAgenda(): array {
        return self::request('GET', ['action' => 'getActiveAgenda']);
    }

    /**
     * Ambil data lengkap dashboard & rekap kehadiran dari GSheet
     */
    public static function getDashboardStats(string $pin = DEFAULT_ADMIN_PIN): array {
        return self::request('GET', [
            'action' => 'getDashboard',
            'pin' => $pin
        ]);
    }

    /**
     * Kirim presensi ke GSheet (Idempotent)
     */
    public static function submitPresensi(array $payload): array {
        return self::request('POST', [
            'action' => 'submitPresensi',
            'payload' => $payload
        ]);
    }

    /**
     * Buat agenda baru di GSheet
     */
    public static function createAgenda(array $payload, string $pin = DEFAULT_ADMIN_PIN): array {
        return self::request('POST', [
            'action' => 'createAgenda',
            'payload' => $payload,
            'pin' => $pin
        ]);
    }

    /**
     * Tutup agenda di GSheet
     */
    public static function closeAgenda(string $agendaId, string $pin = DEFAULT_ADMIN_PIN): array {
        return self::request('POST', [
            'action' => 'closeAgenda',
            'agendaId' => $agendaId,
            'pin' => $pin
        ]);
    }
}

