<?php
$page = $_GET['page'];
// ruleid: radr.php.file-inclusion
include $page . '.php';
// ruleid: radr.php.file-inclusion
require_once($_REQUEST['mod']);
// ok: radr.php.file-inclusion
include 'header.php';
