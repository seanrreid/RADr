<?php
$xml = file_get_contents('php://input');
$doc = new DOMDocument();
// ruleid: radr.php.xxe
$doc->loadXML($xml, LIBXML_NOENT | LIBXML_DTDLOAD);
// ruleid: radr.php.xxe
$s = simplexml_load_string($xml, 'SimpleXMLElement', LIBXML_NOENT);
// ruleid: radr.php.xxe
libxml_disable_entity_loader(false);
// ok: radr.php.xxe
$doc->loadXML($xml);
// ok: radr.php.xxe
$s2 = simplexml_load_string($xml, 'SimpleXMLElement', LIBXML_NONET);
