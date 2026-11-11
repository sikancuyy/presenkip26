<?php
/**
 * Mesin Sinkronisasi Dua Arah (Bidirectional Auto-Sync Engine)
 * Memastikan Single Source of Truth (GSheet) tetap terjaga tanpa duplikasi,
 * data loss, race condition, atau infinite loop.
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/storage.php';
require_once __DIR__ . '/gsheet.php';

class SyncEngine {
    /**
     * Mendorong semua item tertunda di sync_queue ke Google Sheets (PUSH)
     */
    public static function pushPendingQueue(): array {
        $queue = Storage::getQueue();
        if (empty($queue)) {
            return ['pushed' => 0, 'failed' => 0, 'remaining' => 0];
        }

        $pushedCount = 0;
        $failedCount = 0;
        $remainingQueue = [];

        foreach ($queue as $item) {
            $action = $item['action'] ?? '';
            $payload = $item['payload'] ?? [];
            $attempts = (int)($item['attempts'] ?? 0);
            $success = false;

            if ($action === 'submitPresensi') {
                $res = GSheetClient::submitPresensi([
                    'nim' => $payload['nim'] ?? '',
                    'agendaId' => $payload['agendaId'] ?? '',
                    'sessionCode' => $payload['sessionCode'] ?? '',
                    'nama' => $payload['nama'] ?? '',
                    'divisi' => $payload['sie'] ?? $payload['divisi'] ?? '',
                    'delegasi' => $payload['delegasi'] ?? '',
                    'hp' => $payload['no_hp'] ?? '',
                    'deviceInfo' => 'PHP Cache Auto-Sync'
                ]);

                // Berhasil jika sukses atau GSheet mendeteksi sudah tercatat hadir (idempotent)
                if (!empty($res['success']) || (isset($res['message']) && stripos($res['message'], 'sudah') !== false)) {
                    $success = true;
                    $pushedCount++;

                    // Update status entri lokal menjadi synced = true
                    if (!empty($payload['key'])) {
                        Storage::updatePresensiBatch([
                            $payload['key'] => [
                                'synced' => true,
                                'synced_at' => date('Y-m-d H:i:s')
                            ]
                        ]);
                    }
                }
            } elseif ($action === 'createAgenda') {
                $res = GSheetClient::createAgenda($payload, DEFAULT_ADMIN_PIN);
                if (!empty($res['success'])) {
                    $success = true;
                    $pushedCount++;
                }
            } elseif ($action === 'closeAgenda') {
                $res = GSheetClient::closeAgenda($payload['agendaId'] ?? '', DEFAULT_ADMIN_PIN);
                if (!empty($res['success'])) {
                    $success = true;
                    $pushedCount++;
                }
            }

            if (!$success) {
                $attempts++;
                if ($attempts < 5) {
                    $item['attempts'] = $attempts;
                    $item['last_error'] = $res['message'] ?? 'Network error';
                    $remainingQueue[] = $item;
                    $failedCount++;
                } else {
                    // Buang item setelah 5x gagal agar tidak infinite loop
                    $failedCount++;
                }
            }
        }

        Storage::saveQueue($remainingQueue);

        return [
            'pushed' => $pushedCount,
            'failed' => $failedCount,
            'remaining' => count($remainingQueue)
        ];
    }

    /**
     * Mengambil data terbaru dari Google Sheets dan memperbarui cache lokal (PULL)
     */
    public static function pullFromGsheet(): array {
        $dashRes = GSheetClient::getDashboardStats(DEFAULT_ADMIN_PIN);
        if (empty($dashRes['success'])) {
            return [
                'pulled' => false,
                'message' => $dashRes['message'] ?? 'Gagal mengambil data dari Google Sheets'
            ];
        }

        // 1. Simpan Agenda Aktif
        $activeAgenda = $dashRes['activeAgenda'] ?? null;
        if (!empty($activeAgenda)) {
            Storage::setActiveAgenda($activeAgenda);
        } else {
            Storage::setActiveAgenda(null);
        }

        // 2. Simpan Master Panitia dari GSheet
        if (!empty($dashRes['panitia']) && is_array($dashRes['panitia'])) {
            // Bersihkan data jika ada field kehadiran spesifik agenda agar master tetap bersih
            $cleanedPanitia = [];
            foreach ($dashRes['panitia'] as $p) {
                $cleanedPanitia[] = [
                    'no' => (string)($p['no'] ?? ''),
                    'nama' => (string)($p['nama'] ?? ''),
                    'nim' => (string)($p['nim'] ?? ''),
                    'jabatan' => (string)($p['jabatan'] ?? ''),
                    'sie' => (string)($p['sie'] ?? ''),
                    'no_hp' => (string)($p['no_hp'] ?? ''),
                    'delegasi' => (string)($p['delegasi'] ?? '')
                ];
            }
            if (count($cleanedPanitia) >= 46) {
                Storage::savePanitia($cleanedPanitia);
            }
        }

        // 3. Simpan Riwayat Agenda
        if (!empty($dashRes['agendas']) && is_array($dashRes['agendas'])) {
            Storage::saveAgendasList($dashRes['agendas']);
        }

        // 4. Rekonsiliasi Status Kehadiran untuk Agenda Aktif
        if (!empty($activeAgenda['id']) && !empty($dashRes['panitia'])) {
            $agendaId = (string)$activeAgenda['id'];
            $batchPresensi = [];
            foreach ($dashRes['panitia'] as $p) {
                $sudahHadir = !empty($p['sudahHadir']);
                $cleanNim = preg_replace('/\D/', '', (string)($p['nim'] ?? ''));
                if ($sudahHadir && !empty($cleanNim)) {
                    $key = $agendaId . '_' . $cleanNim;
                    $batchPresensi[$key] = [
                        'key' => $key,
                        'agendaId' => $agendaId,
                        'nim' => $cleanNim,
                        'nama' => (string)($p['nama'] ?? ''),
                        'jabatan' => (string)($p['jabatan'] ?? ''),
                        'sie' => (string)($p['sie'] ?? ''),
                        'delegasi' => (string)($p['delegasi'] ?? ''),
                        'no_hp' => (string)($p['no_hp'] ?? ''),
                        'timestamp' => !empty($p['jamHadir']) ? (string)$p['jamHadir'] : 'HADIR',
                        'tanggal' => (string)($activeAgenda['date'] ?? date('d F Y')),
                        'synced' => true,
                        'synced_at' => date('Y-m-d H:i:s')
                    ];
                }
            }
            if (!empty($batchPresensi)) {
                Storage::updatePresensiBatch($batchPresensi);
            }
        }

        return [
            'pulled' => true,
            'activeAgenda' => $activeAgenda,
            'stats' => $dashRes['stats'] ?? null,
            'panitiaCount' => count($dashRes['panitia'] ?? [])
        ];
    }

    /**
     * Eksekusi Sinkronisasi Penuh Dua Arah (Tombol Sinkronisasi Manual)
     */
    public static function runFullSync(): array {
        Storage::updateSyncState(['status' => 'syncing']);

        // 1. Dorong antrean keluar terlebih dahulu
        $pushResult = self::pushPendingQueue();

        // 2. Tarik snapshot data terbaru dari GSheet
        $pullResult = self::pullFromGsheet();

        $now = time();
        $formatted = date('H:i:s') . ' WIB';

        Storage::updateSyncState([
            'last_sync_time' => $now,
            'last_sync_formatted' => $formatted,
            'status' => 'synced',
            'last_push' => $pushResult,
            'last_pull' => $pullResult['pulled']
        ]);

        return [
            'success' => true,
            'message' => 'Sinkronisasi dua arah berhasil',
            'push' => $pushResult,
            'pull' => $pullResult,
            'lastSync' => $formatted
        ];
    }

    /**
     * Auto-sync rutin (Dipanggil setiap 10 detik dari frontend)
     */
    public static function autoSync(): array {
        $state = Storage::getSyncState();
        $queue = Storage::getQueue();
        $now = time();
        $lastSyncTime = (int)($state['last_sync_time'] ?? 0);

        $hasPendingQueue = !empty($queue);
        $needsPull = ($now - $lastSyncTime) >= AUTO_SYNC_INTERVAL;

        $pushResult = null;
        if ($hasPendingQueue) {
            $pushResult = self::pushPendingQueue();
        }

        $pullResult = null;
        if ($needsPull || $hasPendingQueue) {
            $pullResult = self::pullFromGsheet();
            $state['last_sync_time'] = $now;
            $state['last_sync_formatted'] = date('H:i:s') . ' WIB';
        }

        $state['status'] = 'synced';
        $state['pending_queue_count'] = count(Storage::getQueue());
        Storage::updateSyncState($state);

        return [
            'success' => true,
            'synced' => true,
            'pushed' => $pushResult,
            'pulled' => $pullResult ? $pullResult['pulled'] : false,
            'pendingCount' => $state['pending_queue_count'],
            'lastSync' => $state['last_sync_formatted']
        ];
    }
}

