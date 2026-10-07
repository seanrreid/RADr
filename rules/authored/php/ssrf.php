<?php
$url = $_GET['url'];
// ruleid: radr.php.ssrf
$ch = curl_init($url);
$c = curl_init();
// ruleid: radr.php.ssrf
curl_setopt($c, CURLOPT_URL, $_POST['target']);
// ruleid: radr.php.ssrf
$body = file_get_contents($url);
// ok: radr.php.ssrf
$ch2 = curl_init('https://api.example.com/v1/status');
