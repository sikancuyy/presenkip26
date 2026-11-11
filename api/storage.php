<?php
/**
 * Penyimpanan Cache Lokal & Antrean Sinkronisasi (Thread-Safe JSON Storage)
 * Menangani concurrency dengan flock() dan atomic write temp file.
 */

require_once __DIR__ . '/config.php';

class Storage {
    private static function ensureDirectory(): void {
        if (!is_dir(DATA_DIR)) {
            @mkdir(DATA_DIR, 0775, true);
        }
    }

    /**
     * Membaca file JSON dengan Shared Lock (LOCK_SH)
     */
    public static function read(string $filename, $default = []) {
        self::ensureDirectory();
        $path = DATA_DIR . DIRECTORY_SEPARATOR . $filename;
        if (!file_exists($path)) {
            return $default;
        }

        $fp = @fopen($path, 'rb');
        if (!$fp) return $default;

        $content = '';
        if (flock($fp, LOCK_SH)) {
            $content = stream_get_contents($fp);
            flock($fp, LOCK_UN);
        }
        fclose($fp);

        if (empty($content)) return $default;
        $decoded = json_decode($content, true);
        return is_array($decoded) ? $decoded : $default;
    }

    /**
     * Menulis file JSON secara Atomic dengan Exclusive Lock (LOCK_EX)
     */
    public static function write(string $filename, $data): bool {
        self::ensureDirectory();
        $path = DATA_DIR . DIRECTORY_SEPARATOR . $filename;
        $tempPath = $path . '.' . uniqid('tmp_', true);

        $jsonStr = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($jsonStr === false) return false;

        $fp = @fopen($tempPath, 'wb');
        if (!$fp) return false;

        $written = false;
        if (flock($fp, LOCK_EX)) {
            $bytes = fwrite($fp, $jsonStr);
            fflush($fp);
            flock($fp, LOCK_UN);
            $written = ($bytes !== false);
        }
        fclose($fp);

        if ($written) {
            // Atomic rename
            return @rename($tempPath, $path);
        }

        @unlink($tempPath);
        return false;
    }

    // ==========================================
    // 1. DATA PANITIA (46 Master Data)
    // ==========================================

    public static function getPanitia(): array {
        $panitia = self::read('panitia.json', []);
        if (empty($panitia)) {
            $panitia = self::getDefaultPanitia();
            self::write('panitia.json', $panitia);
        }
        return $panitia;
    }

    public static function savePanitia(array $list): bool {
        return self::write('panitia.json', $list);
    }

    public static function findPanitiaByNim(string $nim): ?array {
        $cleanNim = preg_replace('/\D/', '', $nim);
        if (empty($cleanNim)) return null;

        $list = self::getPanitia();
        foreach ($list as $item) {
            $itemNim = preg_replace('/\D/', '', (string)($item['nim'] ?? ''));
            if ($itemNim === $cleanNim) {
                return $item;
            }
        }
        return null;
    }

    // ==========================================
    // 2. AGENDA AKTIF & MASTER AGENDA
    // ==========================================

    public static function getActiveAgenda(): ?array {
        $data = self::read('agenda.json', null);
        if (is_array($data) && !empty($data['status']) && strtoupper($data['status']) === 'AKTIF') {
            return $data;
        }
        return null;
    }

    public static function setActiveAgenda(?array $agenda): bool {
        return self::write('agenda.json', $agenda);
    }

    public static function getAgendasList(): array {
        return self::read('agendas_all.json', []);
    }

    public static function saveAgendasList(array $agendas): bool {
        return self::write('agendas_all.json', $agendas);
    }

    // ==========================================
    // 3. TRANSAKSI PRESENSI (Anti Duplikasi)
    // ==========================================

    /**
     * Mengambil seluruh map presensi: [ "<agendaId>_<nim>" => [ ... ] ]
     */
    public static function getPresensiMap(): array {
        return self::read('presensi.json', []);
    }

    /**
     * Memeriksa apakah NIM sudah presensi di agenda tertentu
     */
    public static function hasAttended(string $agendaId, string $nim): ?array {
        $cleanNim = preg_replace('/\D/', '', $nim);
        $key = $agendaId . '_' . $cleanNim;
        $map = self::getPresensiMap();
        return $map[$key] ?? null;
    }

    /**
     * Mencatat presensi baru secara instan di cache lokal
     * Mengembalikan status apakah sukses baru atau duplikat
     */
    public static function recordPresensi(array $record): array {
        self::ensureDirectory();
        $agendaId = trim((string)($record['agendaId'] ?? ''));
        $cleanNim = preg_replace('/\D/', '', (string)($record['nim'] ?? ''));
        $key = $agendaId . '_' . $cleanNim;

        $path = DATA_DIR . DIRECTORY_SEPARATOR . 'presensi.json';
        $fp = @fopen($path, 'c+b');
        if (!$fp) {
            return ['success' => false, 'message' => 'Gagal mengunci database lokal'];
        }

        $result = ['success' => false];
        if (flock($fp, LOCK_EX)) {
            $content = stream_get_contents($fp);
            $map = !empty($content) ? json_decode($content, true) : [];
            if (!is_array($map)) $map = [];

            if (isset($map[$key])) {
                // Sudah ada, anti-duplikasi aktif
                $result = [
                    'success' => false,
                    'already_attended' => true,
                    'record' => $map[$key],
                    'message' => 'NIM ' . $cleanNim . ' sudah tercatat hadir pada agenda ini.'
                ];
            } else {
                // Entri baru
                $entry = [
                    'key' => $key,
                    'agendaId' => $agendaId,
                    'nim' => $cleanNim,
                    'nama' => $record['nama'] ?? '',
                    'jabatan' => $record['jabatan'] ?? '',
                    'sie' => $record['sie'] ?? '',
                    'delegasi' => $record['delegasi'] ?? '',
                    'no_hp' => $record['no_hp'] ?? '',
                    'sessionCode' => $record['sessionCode'] ?? '',
                    'timestamp' => $record['timestamp'] ?? date('H:i:s'),
                    'tanggal' => $record['tanggal'] ?? date('d F Y'),
                    'synced' => false,
                    'synced_at' => null,
                    'created_at' => date('Y-m-d H:i:s')
                ];
                $map[$key] = $entry;

                // Tulis kembali ke file
                ftruncate($fp, 0);
                rewind($fp);
                fwrite($fp, json_encode($map, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
                fflush($fp);

                // Tambahkan ke outgoing sync queue
                self::enqueue('submitPresensi', $entry);

                $result = [
                    'success' => true,
                    'already_attended' => false,
                    'record' => $entry,
                    'message' => 'Presensi berhasil dicatat.'
                ];
            }
            flock($fp, LOCK_UN);
        }
        fclose($fp);
        return $result;
    }

    /**
     * Memperbarui status presensi saat sinkronisasi dari GSheet
     */
    public static function updatePresensiBatch(array $entries): void {
        self::ensureDirectory();
        $path = DATA_DIR . DIRECTORY_SEPARATOR . 'presensi.json';
        $fp = @fopen($path, 'c+b');
        if (!$fp) return;

        if (flock($fp, LOCK_EX)) {
            $content = stream_get_contents($fp);
            $map = !empty($content) ? json_decode($content, true) : [];
            if (!is_array($map)) $map = [];

            foreach ($entries as $k => $item) {
                if (!isset($map[$k])) {
                    // Masukkan data dari GSheet
                    $map[$k] = $item;
                } else {
                    // Update flag synced
                    $map[$k]['synced'] = true;
                    if (empty($map[$k]['synced_at'])) {
                        $map[$k]['synced_at'] = date('Y-m-d H:i:s');
                    }
                }
            }

            ftruncate($fp, 0);
            rewind($fp);
            fwrite($fp, json_encode($map, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
            fflush($fp);
            flock($fp, LOCK_UN);
        }
        fclose($fp);
    }

    // ==========================================
    // 4. ANTREAN SINKRONISASI (Sync Queue)
    // ==========================================

    public static function getQueue(): array {
        return self::read('sync_queue.json', []);
    }

    public static function enqueue(string $action, array $payload): void {
        self::ensureDirectory();
        $path = DATA_DIR . DIRECTORY_SEPARATOR . 'sync_queue.json';
        $fp = @fopen($path, 'c+b');
        if (!$fp) return;

        if (flock($fp, LOCK_EX)) {
            $content = stream_get_contents($fp);
            $queue = !empty($content) ? json_decode($content, true) : [];
            if (!is_array($queue)) $queue = [];

            $queueItem = [
                'id' => uniqid('q_', true),
                'action' => $action,
                'payload' => $payload,
                'attempts' => 0,
                'created_at' => date('Y-m-d H:i:s')
            ];

            // Anti duplikasi di antrean
            $isDuplicate = false;
            foreach ($queue as $existing) {
                if ($existing['action'] === $action &&
                    ($existing['payload']['key'] ?? '') === ($payload['key'] ?? '___none___')) {
                    $isDuplicate = true;
                    break;
                }
            }

            if (!$isDuplicate) {
                $queue[] = $queueItem;
                ftruncate($fp, 0);
                rewind($fp);
                fwrite($fp, json_encode($queue, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
                fflush($fp);
            }
            flock($fp, LOCK_UN);
        }
        fclose($fp);
    }

    public static function saveQueue(array $queue): bool {
        return self::write('sync_queue.json', array_values($queue));
    }

    // ==========================================
    // 5. STATUS SINKRONISASI
    // ==========================================

    public static function getSyncState(): array {
        return self::read('sync_state.json', [
            'last_sync_time' => null,
            'last_sync_formatted' => 'Belum sinkron',
            'status' => 'idle',
            'pending_queue_count' => 0
        ]);
    }

    public static function updateSyncState(array $patch): void {
        $state = self::getSyncState();
        $updated = array_merge($state, $patch);
        $updated['pending_queue_count'] = count(self::getQueue());
        $updated['updated_at'] = date('Y-m-d H:i:s');
        self::write('sync_state.json', $updated);
    }

    // ==========================================
    // 6. DEFAULT 46 MASTER DATA PANITIA
    // ==========================================

    public static function getDefaultPanitia(): array {
        return [
            ["no" => "1.0", "nama" => "Ananda Haikal", "nim" => "2024613060016", "jabatan" => "Ketua Pelaksana", "sie" => "Pejabat Acara", "no_hp" => "083809998300", "delegasi" => "Dewan Perwakilan Mahasiswa"],
            ["no" => "2.0", "nama" => "Rahmat Haikal", "nim" => "2024203020008", "jabatan" => "Sekretaris Pelaksana", "sie" => "Pejabat Acara", "no_hp" => "082267034994", "delegasi" => "UKM POLYROBOCOM"],
            ["no" => "3.0", "nama" => "Ilal Ilhamdi", "nim" => "2024203020001", "jabatan" => "Bendahara Pelaksana", "sie" => "Pejabat Acara", "no_hp" => "082322085606", "delegasi" => "UKM POLYROBOCOM"],
            ["no" => "4.0", "nama" => "Abdul Razak", "nim" => "2025573010068", "jabatan" => "Ketua Sie Acara", "sie" => "Acara", "no_hp" => "085270767009", "delegasi" => "Badan Eksekutif Mahasiswa"],
            ["no" => "5.0", "nama" => "Indhika Wisnu Pratama", "nim" => "2025203050039", "jabatan" => "Anggota", "sie" => "Acara", "no_hp" => "082171746467", "delegasi" => "UKM Sanggar Seni"],
            ["no" => "6.0", "nama" => "Siti Chairunnisa Aliana", "nim" => "2024583020070", "jabatan" => "Anggota", "sie" => "Acara", "no_hp" => "082286591084", "delegasi" => "UKM Merpati Putih"],
            ["no" => "7.0", "nama" => "Naziihah Putri Fadhiilah", "nim" => "2025623030067", "jabatan" => "Anggota", "sie" => "Acara", "no_hp" => "082276587208", "delegasi" => "UKM Olahraga"],
            ["no" => "8.0", "nama" => "Nanda Al Fajar", "nim" => "2024613060015", "jabatan" => "Anggota", "sie" => "Acara", "no_hp" => "089601072937", "delegasi" => "UKM Resimen Mahasiswa"],
            ["no" => "9.0", "nama" => "Muhammad Khadafi", "nim" => "2025203050014", "jabatan" => "Anggota", "sie" => "Acara", "no_hp" => "082272782806", "delegasi" => "HIMATI"],
            ["no" => "10.0", "nama" => "Mhd. Syahrul Ramadhan", "nim" => "2024583020067", "jabatan" => "Anggota", "sie" => "Acara", "no_hp" => "085372338002", "delegasi" => "HIMAPETRO"],
            ["no" => "11.0", "nama" => "Muhammad Zacky Rizqullah", "nim" => "2025203050038", "jabatan" => "Anggota", "sie" => "Acara", "no_hp" => "081269389274", "delegasi" => "HIMATEKK"],
            ["no" => "12.0", "nama" => "Muhammad Zhafar", "nim" => "2025623030068", "jabatan" => "Anggota", "sie" => "Acara", "no_hp" => "082276997636", "delegasi" => "HIMATRO"],
            ["no" => "13.0", "nama" => "Ghaffara", "nim" => "2025623030076", "jabatan" => "Ketua Sie Humas & Pubdok", "sie" => "Humas & Pubdok", "no_hp" => "081270271500", "delegasi" => "Badan Eksekutif Mahasiswa"],
            ["no" => "14.0", "nama" => "Dhea Fadhilah", "nim" => "2024203020015", "jabatan" => "Anggota", "sie" => "Humas & Pubdok", "no_hp" => "081396263592", "delegasi" => "UKM Pers"],
            ["no" => "15.0", "nama" => "Muhammad Abrar", "nim" => "2024613060012", "jabatan" => "Anggota", "sie" => "Humas & Pubdok", "no_hp" => "082272898739", "delegasi" => "UKM Seni Teater"],
            ["no" => "16.0", "nama" => "Fakhri Alghifari", "nim" => "2025573010064", "jabatan" => "Anggota", "sie" => "Humas & Pubdok", "no_hp" => "081264426573", "delegasi" => "UKM Pramuka"],
            ["no" => "17.0", "nama" => "Gusti Randi Pratama", "nim" => "2024583020063", "jabatan" => "Anggota", "sie" => "Humas & Pubdok", "no_hp" => "085275815615", "delegasi" => "HIMANIA"],
            ["no" => "18.0", "nama" => "M. Rizki Alfareza", "nim" => "2024583020064", "jabatan" => "Anggota", "sie" => "Humas & Pubdok", "no_hp" => "082163351980", "delegasi" => "HIMASIPIL"],
            ["no" => "19.0", "nama" => "Ferdian Syahputra", "nim" => "2025203050037", "jabatan" => "Anggota", "sie" => "Humas & Pubdok", "no_hp" => "082274488390", "delegasi" => "HIMAMESIN"],
            ["no" => "20.0", "nama" => "M. Nabil Alfareza", "nim" => "2025623030070", "jabatan" => "Anggota", "sie" => "Humas & Pubdok", "no_hp" => "085260193499", "delegasi" => "HIMATEL"],
            ["no" => "21.0", "nama" => "Rijalul Hadi", "nim" => "2024203020005", "jabatan" => "Ketua Sie Perlengkapan", "sie" => "Perlengkapan", "no_hp" => "082276587208", "delegasi" => "Badan Eksekutif Mahasiswa"],
            ["no" => "22.0", "nama" => "Putri Sarah", "nim" => "2025573010065", "jabatan" => "Anggota", "sie" => "Perlengkapan", "no_hp" => "085358249022", "delegasi" => "UKM Seni Teater"],
            ["no" => "23.0", "nama" => "Teuku Rayyan Rizqi", "nim" => "2024583020068", "jabatan" => "Anggota", "sie" => "Perlengkapan", "no_hp" => "082276997636", "delegasi" => "UKM Olahraga"],
            ["no" => "24.0", "nama" => "Cut Intan Munira", "nim" => "2025623030074", "jabatan" => "Anggota", "sie" => "Perlengkapan", "no_hp" => "082165038317", "delegasi" => "UKM Sanggar Seni"],
            ["no" => "25.0", "nama" => "Zhafran Ghazy", "nim" => "2024613060014", "jabatan" => "Anggota", "sie" => "Perlengkapan", "no_hp" => "082274488390", "delegasi" => "HIMATI"],
            ["no" => "26.0", "nama" => "Azhari", "nim" => "2025203050040", "jabatan" => "Anggota", "sie" => "Perlengkapan", "no_hp" => "081269389274", "delegasi" => "HIMAPETRO"],
            ["no" => "27.0", "nama" => "M. Zaky Pratama", "nim" => "2024583020066", "jabatan" => "Anggota", "sie" => "Perlengkapan", "no_hp" => "082286591084", "delegasi" => "HIMATEKK"],
            ["no" => "28.0", "nama" => "Rizky Ramadhan", "nim" => "2025623030069", "jabatan" => "Anggota", "sie" => "Perlengkapan", "no_hp" => "085270767009", "delegasi" => "HIMATRO"],
            ["no" => "29.0", "nama" => "M. Hafiz Al Rizky", "nim" => "2024203020007", "jabatan" => "Ketua Sie Konsumsi", "sie" => "Konsumsi", "no_hp" => "081396263592", "delegasi" => "Badan Eksekutif Mahasiswa"],
            ["no" => "30.0", "nama" => "Nurul Fadhilah", "nim" => "2025573010066", "jabatan" => "Anggota", "sie" => "Konsumsi", "no_hp" => "081270271500", "delegasi" => "UKM Merpati Putih"],
            ["no" => "31.0", "nama" => "Raudhatul Jannah", "nim" => "2024613060013", "jabatan" => "Anggota", "sie" => "Konsumsi", "no_hp" => "083809998300", "delegasi" => "UKM Pramuka"],
            ["no" => "32.0", "nama" => "Siti Sarah", "nim" => "2025203050041", "jabatan" => "Anggota", "sie" => "Konsumsi", "no_hp" => "082272898739", "delegasi" => "UKM Pers"],
            ["no" => "33.0", "nama" => "Safira Maulida", "nim" => "2024583020065", "jabatan" => "Anggota", "sie" => "Konsumsi", "no_hp" => "081264426573", "delegasi" => "HIMANIA"],
            ["no" => "34.0", "nama" => "Cut Dara Phonna", "nim" => "2025623030071", "jabatan" => "Anggota", "sie" => "Konsumsi", "no_hp" => "085275815615", "delegasi" => "HIMASIPIL"],
            ["no" => "35.0", "nama" => "Nadia Ulfa", "nim" => "2024203020006", "jabatan" => "Anggota", "sie" => "Konsumsi", "no_hp" => "082163351980", "delegasi" => "HIMAMESIN"],
            ["no" => "36.0", "nama" => "Cut Mutia", "nim" => "2025573010067", "jabatan" => "Anggota", "sie" => "Konsumsi", "no_hp" => "085260193499", "delegasi" => "HIMATEL"],
            ["no" => "37.0", "nama" => "Teuku M. Alfarisi", "nim" => "2024613060011", "jabatan" => "Ketua Sie Keamanan", "sie" => "Keamanan", "no_hp" => "085358249022", "delegasi" => "Badan Eksekutif Mahasiswa"],
            ["no" => "38.0", "nama" => "M. Al Ghifari", "nim" => "2025203050042", "jabatan" => "Anggota", "sie" => "Keamanan", "no_hp" => "082165038317", "delegasi" => "UKM Resimen Mahasiswa"],
            ["no" => "39.0", "nama" => "Rizki Maulana", "nim" => "2024583020062", "jabatan" => "Anggota", "sie" => "Keamanan", "no_hp" => "082267034994", "delegasi" => "UKM Merpati Putih"],
            ["no" => "40.0", "nama" => "M. Rizki Ramadhan", "nim" => "2025623030072", "jabatan" => "Anggota", "sie" => "Keamanan", "no_hp" => "082322085606", "delegasi" => "UKM Olahraga"],
            ["no" => "41.0", "nama" => "Alfi Syahrin", "nim" => "2024203020004", "jabatan" => "Anggota", "sie" => "Keamanan", "no_hp" => "085270767009", "delegasi" => "HIMATI"],
            ["no" => "42.0", "nama" => "M. Ilham", "nim" => "2025573010063", "jabatan" => "Anggota", "sie" => "Keamanan", "no_hp" => "082171746467", "delegasi" => "HIMAPETRO"],
            ["no" => "43.0", "nama" => "Dedi Saputra", "nim" => "2024613060010", "jabatan" => "Anggota", "sie" => "Keamanan", "no_hp" => "082286591084", "delegasi" => "HIMATEKK"],
            ["no" => "44.0", "nama" => "Teuku Rian", "nim" => "2025203050043", "jabatan" => "Anggota", "sie" => "Keamanan", "no_hp" => "082276587208", "delegasi" => "HIMATRO"],
            ["no" => "45.0", "nama" => "Muhammad Fadil", "nim" => "2024583020061", "jabatan" => "Anggota", "sie" => "Keamanan", "no_hp" => "089601072937", "delegasi" => "HIMANIA"],
            ["no" => "46.0", "nama" => "Ahmad Fauzi", "nim" => "2025623030073", "jabatan" => "Anggota", "sie" => "Keamanan", "no_hp" => "082272782806", "delegasi" => "HIMASIPIL"]
        ];
    }
}

