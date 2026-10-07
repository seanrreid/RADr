<?php
$name = $_GET['name'];
// ruleid: radr.php.xss
echo "Hello " . $name;
// ruleid: radr.php.xss
print($_POST['msg']);
// ok: radr.php.xss
echo "Hello " . htmlspecialchars($name, ENT_QUOTES, 'UTF-8');
// ok: radr.php.xss
echo "static";
