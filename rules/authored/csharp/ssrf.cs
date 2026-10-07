using System.Net.Http;
using Microsoft.AspNetCore.Mvc;

public class FetchController : Controller
{
    private readonly HttpClient client = new HttpClient();

    public async System.Threading.Tasks.Task<string> Fetch()
    {
        string url = Request.Query["url"];
        // ruleid: radr.csharp.ssrf
        var body = await client.GetStringAsync(url);
        // ok: radr.csharp.ssrf
        var status = await client.GetStringAsync("https://api.example.com/status");
        return body + status;
    }
}
