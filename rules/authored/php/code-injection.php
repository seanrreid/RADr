<?php
$code = $_POST['code'];
// ruleid: radr.php.code-injection
eval($code);
// ruleid: radr.php.code-injection
call_user_func($_GET['fn'], 1);
// ok: radr.php.code-injection
eval('return 1;');
