import flask
import jinja2
from flask import request

app = flask.Flask(__name__)


@app.route("/hello")
def hello():
    name = request.args.get("name")
    # ruleid: radr.python.ssti-template-from-variable
    return flask.render_template_string("Hello " + name)


def page(user_template):
    # ruleid: radr.python.ssti-template-from-variable
    return jinja2.Template(user_template).render()


def safe():
    # ok: radr.python.ssti-template-from-variable
    return flask.render_template_string("Hello {{ name }}", name="x")
