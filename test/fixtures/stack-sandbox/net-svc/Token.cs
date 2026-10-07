using System;
using Newtonsoft.Json;

namespace Acme;

public static class Token
{
    public static string New()
    {
        var r = new Random();
        return JsonConvert.SerializeObject(new { id = r.Next() });
    }
}
